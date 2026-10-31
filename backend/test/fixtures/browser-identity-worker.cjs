'use strict';
// A directly owned waiting worker. No project code or arbitrary process discovery.
process.on('message',message=>{
 if(message?.finish===true){process.exit(0);return;}
});
process.send?.({ready:true,pid:process.pid});
