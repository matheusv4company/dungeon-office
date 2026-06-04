// Compoe 10 personagens LPC (camadas em __lpc/) e recorta o ciclo de caminhada.
// Saida: client/public/assets/chars/char{0..9}.png (576x256 = 4 direcoes x 9 frames, 64px)
// + manifest.json com nomes. Rode: node tools/build-characters.mjs
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(process.cwd());
const SRC = join(ROOT, "__lpc");
const OUT = join(ROOT, "client", "public", "assets", "chars");
mkdirSync(OUT, { recursive: true });

const W = 832;
const H = 1344;
// Layout LPC classico: caminhada nas linhas 8-11 (y=512), 9 frames (x=0..576)
const WALK = { left: 0, top: 512, width: 576, height: 256 };

const chars = [
  { id: "cavaleiro", name: "Cavaleiro", layers: ["body/male/light.png", "legs/armor/male/metal_pants_male.png", "torso/plate/chest_male.png", "torso/plate/arms_male.png", "head/helms/male/metal_helm_male.png"] },
  { id: "cav_dourado", name: "Cavaleiro Dourado", layers: ["body/male/light.png", "legs/armor/male/golden_greaves_male.png", "torso/gold/chest_male.png", "torso/gold/arms_male.png", "head/helms/male/golden_helm_male.png"] },
  { id: "soldado", name: "Soldado", layers: ["body/male/tanned.png", "legs/armor/male/metal_pants_male.png", "torso/chain/mail_male.png", "torso/chain/tabard/jacket_male.png", "head/helms/male/chainhat_male.png"] },
  { id: "mago", name: "Mago", layers: ["body/male/light.png", "legs/skirt/male/robe_skirt_male.png", "torso/shirts/longsleeve/male/teal_longsleeve.png", "head/hoods/male/cloth_hood_male.png"] },
  { id: "arqueiro", name: "Arqueiro", layers: ["body/male/tanned.png", "legs/pants/male/teal_pants_male.png", "torso/leather/chest_male.png", "torso/leather/shoulders_male.png", "hair/male/bangs/brown.png", "head/caps/male/leather_cap_male.png"] },
  { id: "ladino", name: "Ladino", layers: ["body/male/dark.png", "legs/pants/male/magenta_pants_male.png", "torso/shirts/longsleeve/male/maroon_longsleeve.png", "head/hoods/male/cloth_hood_male.png"] },
  { id: "guerreiro", name: "Guerreiro", layers: ["body/male/tanned.png", "legs/pants/male/red_pants_male.png", "torso/leather/chest_male.png", "torso/leather/shoulders_male.png", "hair/male/bangs/brown.png"] },
  { id: "senhor_guerra", name: "Senhor de Guerra", layers: ["body/male/light.png", "legs/armor/male/metal_pants_male.png", "torso/plate/chest_male.png", "torso/plate/arms_male.png", "hair/male/bangs/raven.png"] },
  { id: "clerigo", name: "Clérigo", layers: ["body/male/light.png", "legs/skirt/male/robe_skirt_male.png", "torso/shirts/longsleeve/male/white_longsleeve.png", "head/hoods/male/cloth_hood_male.png"] },
  { id: "elfo", name: "Elfo Sombrio", layers: ["body/male/darkelf.png", "legs/pants/male/teal_pants_male.png", "torso/leather/chest_male.png", "hair/male/bangslong/blonde.png"] },
];

const manifest = [];
for (let i = 0; i < chars.length; i++) {
  const c = chars[i];
  const comps = c.layers.map((p) => ({ input: join(SRC, ...p.split("/")), top: 0, left: 0 }));
  const composed = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(comps)
    .png()
    .toBuffer();
  const outFile = join(OUT, `char${i}.png`);
  await sharp(composed).extract(WALK).png().toFile(outFile);
  manifest.push({ index: i, id: c.id, name: c.name });
  console.log(`char${i}  ${c.name}`);
}

writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("OK ->", OUT);
