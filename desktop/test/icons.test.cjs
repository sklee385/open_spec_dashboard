const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
test('트레이 PNG와 Windows ICO는 읽을 수 있는 실제 로고와 작은 배율 이미지를 포함한다', () => {
  const png = fs.readFileSync(path.join(__dirname,'../assets/openspecboard.png'));
  assert.equal(png.subarray(1,4).toString(),'PNG');
  assert.equal(png.readUInt32BE(16),256); assert.equal(png.readUInt32BE(20),256);
  const data=[]; for(let offset=8;offset<png.length;){const length=png.readUInt32BE(offset);if(png.toString('ascii',offset+4,offset+8)==='IDAT')data.push(png.subarray(offset+8,offset+8+length));offset+=length+12;}
  assert.ok(zlib.inflateSync(Buffer.concat(data)).length>256*256*3);
  const ico=fs.readFileSync(path.join(__dirname,'../assets/openspecboard.ico'));
  assert.equal(ico.readUInt16LE(0),0); assert.equal(ico.readUInt16LE(2),1);
  const sizes=[];for(let i=0;i<ico.readUInt16LE(4);i++){const at=6+i*16,size=ico[at]||256,length=ico.readUInt32LE(at+8),offset=ico.readUInt32LE(at+12);sizes.push(size);assert.ok(offset+length<=ico.length);assert.equal(ico.subarray(offset+1,offset+4).toString(),'PNG');}
  for(const size of [16,20,24,32,48,64,128,256])assert.ok(sizes.includes(size));
  assert.equal(require('../electron-builder.cjs').win.icon,'desktop/assets/openspecboard.ico');
});
test('Windows 트레이는 ICO를 사용하고 디코딩 실패 시 PNG를 확인하며 빈 이미지를 조용히 사용하지 않는다', () => {
  const {createTrayIcon}=require('../icons.cjs');const calls=[];
  const image={isEmpty:()=>false};
  assert.equal(createTrayIcon({createFromPath:file=>{calls.push(file);return image}},'C:/fixture','win32'),image);
  assert.match(calls[0],/openspecboard\.ico$/);
  const fallback=[];createTrayIcon({createFromPath:file=>{fallback.push(file);return {isEmpty:()=>file.endsWith('.ico')}}},'C:/fixture','win32');
  assert.equal(fallback.length,2);assert.match(fallback[1],/openspecboard\.png$/);
  assert.throws(()=>createTrayIcon({createFromPath:()=>({isEmpty:()=>true})},'C:/fixture','win32'),/아이콘/);
});
