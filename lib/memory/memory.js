import Promise from 'promise-polyfill';
import { idbKeyval } from './idb';

// Going to set the key for idbKeyval as the cartridge header.
// Then, for each cartridge, it will return an object.
// there will be a cartridgeRam Key, settings Key, and a saveState key
// Not going to make one giant object, as we want to keep idb transactions light and fast

// Declare some memory constants
const MEMORY_ADDRESSES = {
  CARTRIDGE_RAM: 0x008400,
  CARTRIDGE_ROM: 0x073800,
  WASMBOY_INTERNAL_STATE: {
    LOCATION: 0x000000,
    SIZE: 0x000400
  },
  GAMEBOY_MEMORY: {
    LOCATION: 0x000400,
    SIZE: 0x008000
  }
};

const WASMBOY_UNLOAD_STORAGE = 'WASMBOY_UNLOAD_STORAGE';

//  Will save the state in parts, to easy memory map changes:
// https://docs.google.com/spreadsheets/d/17xrEzJk5-sCB9J2mMJcVnzhbE-XH_NvczVSQH9OHvRk/edit?usp=sharing
const WASMBOY_SAVE_STATE_SCHEMA = {
  wasmBoyMemory: {
    wasmBoyInternalState: [],
    gameBoyMemory: [],
    cartridgeRam: []
  },
  date: undefined,
  name: undefined,
  isAuto: undefined
}

// Private function to get the cartridge header
const getCartridgeHeader = (wasmByteMemory) => {

  if (!wasmByteMemory) {
    return false;
  }

  // Header is at 0x0134 - 0x014F
  // http://gbdev.gg8.se/wiki/articles/The_Cartridge_Header
  const headerLength = 0x014F - 0x0134;
  const headerArray = new Uint8Array(headerLength);
  for(let i = 0; i <= headerLength; i++) {
    // Get the CARTRIDGE_ROM + the offset to point us at the header, plus the current byte
    headerArray[i] = wasmByteMemory[MEMORY_ADDRESSES.CARTRIDGE_ROM + 0x0134 + i];
  }

  return headerArray;
}

// Private function to get the caretridge ram
const getCartridgeRam = (wasmByteMemory) => {

  if (!wasmByteMemory) {
    return false;
  }

  // Depening on the rom type, we will have different ram sizes.
  // Due memory restrictions described in:
  // https://developers.google.com/web/fundamentals/instant-and-offline/web-storage/offline-for-pwa
  // We will make sure to only store as much as we need per ROM :)

  // Similar to `initializeCartridgeType()` in `wasm/memory/memory.ts`
  // We will determine our cartridge type
  // Get our game MBC type from the cartridge header
  // http://gbdev.gg8.se/wiki/articles/The_Cartridge_Header
  let cartridgeType = wasmByteMemory[MEMORY_ADDRESSES.CARTRIDGE_ROM + 0x0147];

  let ramSize = undefined;
  if(cartridgeType === 0x00) {
    // No memory for this rom type
    return false;
  } else if (cartridgeType >= 0x01 && cartridgeType <= 0x03) {
    // MBC1 32KB of Ram
    ramSize = 0x8000;
  } else if (cartridgeType >= 0x05 && cartridgeType <= 0x06) {
    // MBC2 512X4 Bytes, 2KB
    ramSize = 0x800;
  } else if (cartridgeType >= 0x0F && cartridgeType <= 0x13) {
    // MBC3 32KB of Ram
    ramSize = 0x8000;
  } else if (cartridgeType >= 0x19 && cartridgeType <= 0x1E) {
    // MBC5 128KB of Ram
    ramSize = 0x20000;
  }

  if(!ramSize) {
    return false;
  }

  // Finally fill our cartridgeRam from the ram in memory
  const cartridgeRam = new Uint8Array(ramSize);

  for(let i = 0; i < (ramSize); i++) {
    cartridgeRam[i] = wasmByteMemory[MEMORY_ADDRESSES.CARTRIDGE_RAM + i];
  }

  return cartridgeRam;
}

// Function to return a save state of the current memory
const getSaveState = (wasmByteMemory) => {
  // Simply read up to: 0x0083FF,
  // then append our catridge ram
  const cartridgeRam = getCartridgeRam(wasmByteMemory);

  const wasmBoyInternalState = new Uint8Array(MEMORY_ADDRESSES.WASMBOY_INTERNAL_STATE.SIZE);
  const gameBoyMemory = new Uint8Array(MEMORY_ADDRESSES.GAMEBOY_MEMORY.SIZE);

  for (let i = 0; i < MEMORY_ADDRESSES.WASMBOY_INTERNAL_STATE.SIZE; i++) {
    wasmBoyInternalState[i] =
      wasmByteMemory[i + MEMORY_ADDRESSES.WASMBOY_INTERNAL_STATE.LOCATION];
  }

  for (let i = 0; i < MEMORY_ADDRESSES.GAMEBOY_MEMORY.SIZE; i++) {
    gameBoyMemory[i] =
      wasmByteMemory[i + MEMORY_ADDRESSES.GAMEBOY_MEMORY.LOCATION];
  }

  const saveState = Object.assign({}, WASMBOY_SAVE_STATE_SCHEMA);

  saveState.wasmBoyMemory.wasmBoyInternalState = wasmBoyInternalState;
  saveState.wasmBoyMemory.gameBoyMemory = gameBoyMemory;
  saveState.wasmBoyMemory.cartridgeRam = cartridgeRam;
  saveState.date = Date.now();

  return saveState;
}

const loadSaveState = (wasmByteMemory, saveState) => {

  for (let i = 0; i  < MEMORY_ADDRESSES.WASMBOY_INTERNAL_STATE.SIZE; i++) {
    wasmByteMemory[i + MEMORY_ADDRESSES.WASMBOY_INTERNAL_STATE.LOCATION] =
      saveState.wasmBoyMemory.wasmBoyInternalState[i];
  }

  for (let i = 0; i < MEMORY_ADDRESSES.GAMEBOY_MEMORY.SIZE; i++) {
    wasmByteMemory[i + MEMORY_ADDRESSES.GAMEBOY_MEMORY.LOCATION] =
      saveState.wasmBoyMemory.gameBoyMemory[i];
  }

  for (let i = 0; i < saveState.wasmBoyMemory.cartridgeRam.length; i++) {
    wasmByteMemory[i + MEMORY_ADDRESSES.CARTRIDGE_RAM] =
      saveState.wasmBoyMemory.cartridgeRam[i];
  }

  return true;
};

class WasmBoyMemoryService {

  constructor() {
    this.wasmInstance = undefined;
    this.wasmByteMemory = undefined;
    this.loadedCartridgeMemoryState = {
      ROM: false,
      RAM: false
    };
  }

  initialize(wasmInstance, wasmByteMemory, includeBootRom) {
    this.wasmInstance = wasmInstance;
    this.wasmByteMemory = wasmByteMemory;

    // Set listeners to ensure we save our cartridge ram before closing
    window.addEventListener("beforeunload", () => {
      // Need to add a retrun value, and force all code in the block to be sync
      // https://stackoverflow.com/questions/7255649/window-onbeforeunload-not-working
      // http://vaughnroyko.com/idbonbeforeunload/
      // https://bugzilla.mozilla.org/show_bug.cgi?id=870645

      // Solution:
      // ~~Try to force sync: https://www.npmjs.com/package/deasync~~ Didn't work, requires fs
      // Save to local storage, and pick it back up in init: https://bugs.chromium.org/p/chromium/issues/detail?id=144862

      // TODO: Ensure that reloading without loading the game rom, and not the game ram will overwrite our saved ram

      // Get our cartridge ram and header
      const header = getCartridgeHeader(this.wasmByteMemory);
      const cartridgeRam = getCartridgeRam(this.wasmByteMemory);

      // Get our save state, and un type our arrays
      const saveState = getSaveState(this.wasmByteMemory);
      const saveStateMemoryKeys = Object.keys(saveState.wasmBoyMemory);
      for (let i = 0; i < saveStateMemoryKeys.length; i++) {
        saveState.wasmBoyMemory[saveStateMemoryKeys[i]] =
          Array.prototype.slice.call(saveState.wasmBoyMemory[saveStateMemoryKeys[i]]);
      }

      // Set isAuto
      saveState.isAuto = true;

      // Need to vonert types arrays, and back, or selse wll get indexed JSON
      // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Typed_arrays
      localStorage.setItem(WASMBOY_UNLOAD_STORAGE, JSON.stringify({
        header: Array.prototype.slice.call(header),
        cartridgeRam: Array.prototype.slice.call(cartridgeRam),
        saveState: saveState
      }));

      return null;
    }, false);

    // Load any unloaded storage in our localStorage
    const unloadStorage = localStorage.getItem(WASMBOY_UNLOAD_STORAGE);
    if (unloadStorage) {
      const unloadStorageObject = JSON.parse(unloadStorage);
      localStorage.removeItem(WASMBOY_UNLOAD_STORAGE);

      const header = new Uint8Array(unloadStorageObject.header);
      const cartridgeRam = new Uint8Array(unloadStorageObject.cartridgeRam);

      // Get our save state, and re-type our array
      const saveState = unloadStorageObject.saveState;
      if (saveState) {
        const saveStateMemoryKeys = Object.keys(saveState.wasmBoyMemory);
        for (let i = 0; i < saveStateMemoryKeys.length; i++) {
          saveState.wasmBoyMemory[saveStateMemoryKeys[i]] =
            new Uint8Array(saveState.wasmBoyMemory[saveStateMemoryKeys[i]]);
        }
      }

      this.saveCartridgeRam(header, cartridgeRam).then(() => {
        this.saveState(header, saveState).then(() => {
          return Promise.resolve();
        }).catch((error) => {
          return Promise.reject(error);
        });
      }).catch((error) => {
        return Promise.reject(error);
      });
    } else {
      return Promise.resolve();
    }
  }

  initializeHeadless(wasmInstance, wasmByteMemory) {
    this.wasmInstance = wasmInstance;
    this.wasmByteMemory = wasmByteMemory;
  }

  getLoadedCartridgeMemoryState() {
    return this.loadedCartridgeMemoryState;
  }

  clearMemory() {
    // Clear Wasm memory
    // https://docs.google.com/spreadsheets/d/17xrEzJk5-sCB9J2mMJcVnzhbE-XH_NvczVSQH9OHvRk/edit?usp=sharing
    for(let i = 0; i <= this.wasmByteMemory.length; i++) {
      this.wasmByteMemory[i] = 0;
    }

    this.loadedCartridgeMemoryState.ROM = false;
    this.loadedCartridgeMemoryState.RAM = false;
  }

  loadCartridgeRom(gameBytes, bootRom) {

    // Load the game data into actual memory
    for(let i = 0; i < gameBytes.length; i++) {
      if (gameBytes[i]) {
        this.wasmByteMemory[MEMORY_ADDRESSES.CARTRIDGE_ROM + i] = gameBytes[i];
      }
    }

    // TODO: Handle getting a boot rom
    this.wasmInstance.exports.initialize(0);

      this.loadedCartridgeMemoryState.ROM = true;
  }

  // Function to save the cartridge ram
  // This emulates the cartridge having a battery to
  // Keep things like Pokemon Save data in memory
  // Also allows passing in a a Uint8Array header and ram to be set manually
  saveCartridgeRam(passedHeader, passedCartridgeRam) {

    return new Promise((resolve, reject) => {
      // Get the entire header in byte memory
      // Each version of a rom can have similar title and checksums
      // Therefore comparing all of it should help with this :)
      // https://drive.google.com/file/d/0B7y-o-Uytiv9OThXWXFCM1FPbGs/view
      let header;
      let cartridgeRam;
      if(passedHeader && passedCartridgeRam) {
        header = passedHeader;
        cartridgeRam = passedCartridgeRam;
      } else {
        header = getCartridgeHeader(this.wasmByteMemory);
        cartridgeRam = getCartridgeRam(this.wasmByteMemory);
      }

      if(!header || !cartridgeRam) {
        console.error('Error parsing the cartridgeRam or cartridge header', header, cartridgeRam);
        reject('Error parsing the cartridgeRam or cartridge header');
      }

      // Get our cartridge object
      idbKeyval.get(header).then((cartridgeObject) => {

        if(!cartridgeObject) {
          cartridgeObject = {};
        }

        // Set the cartridgeRam to our cartridgeObject
        cartridgeObject.cartridgeRam = cartridgeRam;

        idbKeyval.set(header, cartridgeObject).then(() => {
          resolve();
        }).catch((error) => {
          reject(error);
        });
      }).catch((error) => {
        reject(error);
      });
    });
  }

  // function to load the cartridge ram
  // opposite of above
  loadCartridgeRam() {

    return new Promise((resolve, reject) => {
      // Get the entire header in byte memory
      // Each version of a rom can have similar title and checksums
      // Therefore comparing all of it should help with this :)
      // https://drive.google.com/file/d/0B7y-o-Uytiv9OThXWXFCM1FPbGs/view
      const header = getCartridgeHeader(this.wasmByteMemory);

      if(!header) {
        reject('Error parsing the cartridge header');
      }

      idbKeyval.get(header).then((cartridgeObject) => {

        if(!cartridgeObject || !cartridgeObject.cartridgeRam) {
          resolve();
          return;
        }

        // Set the cartridgeRam
        for(let i = 0; i < cartridgeObject.cartridgeRam.length; i++) {
           this.wasmByteMemory[MEMORY_ADDRESSES.CARTRIDGE_RAM + i] = cartridgeObject.cartridgeRam[i];
        }
        this.loadedCartridgeMemoryState.RAM = true;
        resolve();
      }).catch((error) => {
        reject(error);
      });
    });
  }

  // Function to save the state to the indexeddb
  saveState(passedHeader, passedSaveState) {

    return new Promise((resolve, reject) => {

      // Save our internal wasmboy state to memory
      this.wasmInstance.exports.saveState();

      // Get our save state
      let saveState;
      let header;
      if (passedHeader && passedSaveState) {
        saveState = passedSaveState;
        header = passedHeader;
      } else {
        saveState = getSaveState(this.wasmByteMemory);
        header = getCartridgeHeader(this.wasmByteMemory);
      }

      if(!header) {
        reject('Error parsing the cartridge header');
      }

      idbKeyval.get(header).then((cartridgeObject) => {

        if(!cartridgeObject) {
          cartridgeObject = {};
        }

        if(!cartridgeObject.saveStates) {
          cartridgeObject.saveStates = [];
        }

        cartridgeObject.saveStates.push(saveState);

        idbKeyval.set(header, cartridgeObject).then(() => {
          resolve();
        }).catch((error) => {
          reject(error);
        });
      }).catch((error) => {
        reject(error);
      });
    });
  }

  loadState(saveStateIndex) {
    return new Promise((resolve, reject) => {

      const header = getCartridgeHeader(this.wasmByteMemory);

      if(!header) {
        reject('Error parsing the cartridge header');
      }

      idbKeyval.get(header).then((cartridgeObject) => {

        if(!cartridgeObject || !cartridgeObject.saveStates) {
          reject('No Cartridge Object or saveStates array found');
          return;
        }

        // Get a default saveStateIndex
        if(!saveStateIndex) {
          // Default to the latest save state, or but attempt to default to the first non-auto save state
          saveStateIndex = cartridgeObject.saveStates.length - 1;
          for (let i = cartridgeObject.saveStates.length - 1; i >= 0; i--) {
            if (!cartridgeObject.saveStates[i].isAuto) {
              saveStateIndex = i;
              i = -1;
            }
          }
        }
        loadSaveState(this.wasmByteMemory, cartridgeObject.saveStates[saveStateIndex]);

        // Load back out internal wasmboy state from memory
        this.wasmInstance.exports.loadState();

        resolve();
      }).catch((error) => {
        reject(error);
      });
    });
  }

  // Function to return the current cartridge object
  getCartridgeObject() {
    const header = getCartridgeHeader(this.wasmByteMemory);
    return idbKeyval.get(header);
  }
}

// Create a singleton to export
export const WasmBoyMemory = new WasmBoyMemoryService();