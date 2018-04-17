import { Component } from 'preact';
import Promise from 'promise-polyfill';

const canvasId = 'WasmBoyTileData';
const tileDataXPixels = 0x1F * 8;
const tileDataYPixels = 0x17 * 8;

export class WasmBoyTileData extends Component {
  constructor(props) {
		super(props);
  }

  componentDidMount() {
    const canvasElement = document.getElementById(canvasId);
    const canvasContext = canvasElement.getContext('2d');
    const canvasImageData = canvasContext.createImageData(tileDataXPixels, tileDataYPixels);

    // Add some css for smooth 8-bit canvas scaling
    // https://stackoverflow.com/questions/7615009/disable-interpolation-when-scaling-a-canvas
    // https://caniuse.com/#feat=css-crisp-edges
    canvasElement.style = `
      image-rendering: optimizeSpeed;
      image-rendering: -moz-crisp-edges;
      image-rendering: -webkit-optimize-contrast;
      image-rendering: -o-crisp-edges;
      image-rendering: pixelated;
      -ms-interpolation-mode: nearest-neighbor;
    `;

    // Fill the canvas with a blank screen
    // using client width since we are not requiring a width and height oin the canvas
    // https://developer.mozilla.org/en-US/docs/Web/API/Element/clientWidth
    // TODO: Mention respopnsive canvas scaling in the docs
    canvasContext.clearRect(0, 0, canvasElement.width, canvasElement.height);

    const updateCanvas = () => {
      this.updateCanvas(canvasElement, canvasContext, canvasImageData).then(() => {
        setTimeout(() => {
          updateCanvas();
        }, 500);
      });
    }
    updateCanvas();
  }

  updateCanvas(canvasElement, canvasContext, canvasImageData) {
    return new Promise((resolve) => {

      // Dont update for the following
      if(!this.props.wasmboy.wasmByteMemory ||
        !this.props.wasmboy.wasmInstance ||
        !this.props.wasmboy.ready ||
        this.props.wasmboy.paused ||
        !this.props.shouldUpdate) {
        resolve();
        return;
      }

      this.props.wasmboy.wasmInstance.exports.drawTileDataToWasmMemory();

      const imageDataArray = new Uint8ClampedArray(tileDataYPixels * tileDataXPixels * 4);
      const rgbColor = new Uint8ClampedArray(3);

      for(let y = 0; y < tileDataYPixels; y++) {
        for (let x = 0; x < tileDataXPixels; x++) {

          // Each color has an R G B component
          let pixelStart = ((y * tileDataXPixels) + x) * 3;

          for (let color = 0; color < 3; color++) {
            rgbColor[color] = this.props.wasmboy.wasmByteMemory[
              this.props.wasmboy.wasmInstance.exports.tileDataMap + pixelStart + color
            ];
          }

          // Doing graphics using second answer on:
          // https://stackoverflow.com/questions/4899799/whats-the-best-way-to-set-a-single-pixel-in-an-html5-canvas
          // Image Data mapping
          const imageDataIndex = (x + (y * tileDataXPixels)) * 4;

          imageDataArray[imageDataIndex] = rgbColor[0];
          imageDataArray[imageDataIndex + 1] = rgbColor[1];
          imageDataArray[imageDataIndex + 2] = rgbColor[2];
          // Alpha, no transparency
          imageDataArray[imageDataIndex + 3] = 255;
        }
      }

      // Add our new imageData
      for(let i = 0; i < imageDataArray.length; i++) {
        canvasImageData.data[i] = imageDataArray[i];
      }

      canvasContext.beginPath();
      canvasContext.clearRect(0, 0, tileDataXPixels, tileDataYPixels);
      canvasContext.putImageData(canvasImageData, 0, 0);

      resolve();
    });
  }

  render() {
    return (
      <div>
        <canvas id={canvasId} width={tileDataXPixels} height={tileDataYPixels}>
        </canvas>
      </div>
    )
  }
}