import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { CharacterSelectScene } from "./scenes/CharacterSelectScene";
import { OfficeScene } from "./scenes/OfficeScene";

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#15131d",
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: "100%",
    height: "100%",
  },
  physics: {
    default: "arcade",
    arcade: { debug: false },
  },
  dom: {
    createContainer: true,
  },
  render: {
    preserveDrawingBuffer: true,
  },
  scene: [BootScene, CharacterSelectScene, OfficeScene],
};

const game = new Phaser.Game(config);
(window as Window & { game?: Phaser.Game }).game = game;
