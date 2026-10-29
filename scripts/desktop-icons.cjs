// Rasterize the existing product SVG; generated PNG/ICO assets are committed.
const fs=require('node:fs/promises'),path=require('node:path');
const sharp=require(process.argv[2] || 'sharp');
(async()=>{
  const root=path.resolve(__dirname,'..'),source=await fs.readFile(path.join(root,'frontend/public/openspecboard-icon.svg'));
  const sizes=[16,20,24,32,48,64,128,256],images=[];
  for(const size of sizes)images.push(await sharp(source,{density:384}).resize(size,size).ensureAlpha().png({palette:false}).toBuffer());
  const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
  images.forEach((image,i)=>{const at=6+i*16;header[at]=header[at+1]=sizes[i]===256?0:sizes[i];header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(image.length,at+8);header.writeUInt32LE(offset,at+12);offset+=image.length;});
  const directory=path.join(root,'desktop/assets');await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'openspecboard.png'),images.at(-1));await fs.writeFile(path.join(directory,'openspecboard.ico'),Buffer.concat([header,...images]));
  console.log('기존 로고 PNG·Windows 16–256px ICO 생성 완료');
})().catch(error=>{console.error(error.message);process.exitCode=1});
