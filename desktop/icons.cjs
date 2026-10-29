const {join}=require('node:path');
function createTrayIcon(nativeImage,directory=__dirname,platform=process.platform){
  const names=platform==='win32'?['openspecboard.ico','openspecboard.png']:['openspecboard.png'];
  for(const name of names){const image=nativeImage.createFromPath(join(directory,'assets',name));if(!image.isEmpty())return image;}
  throw Error('OpenSpecBoard 트레이 아이콘을 불러오지 못했습니다');
}
module.exports={createTrayIcon};
