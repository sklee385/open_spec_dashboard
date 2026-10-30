import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, truncateSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { collectFiles, differences } from '../src/work/file-results';
it('대용량 소스 파일은 전체 본문 할당 전에 한도 초과로 거부하고 원본을 유지한다',()=>{
 const root=mkdtempSync(join(tmpdir(),'bounded-')),file=join(root,'large-source.bin');writeFileSync(file,'x');truncateSync(file,128*1024**2+1);
 try{expect(()=>collectFiles(root)).toThrow(/한도/);expect(statSync(file).size).toBe(128*1024**2+1);}finally{expect(dirname(resolve(file))).toBe(resolve(root));unlinkSync(file);}
},15000);
it('상속 이름을 가진 실제 파일도 빠뜨리지 않고 과거 빈 기준에서 추가 diff로 남긴다',()=>{
 const root=mkdtempSync(join(tmpdir(),'names-'));writeFileSync(join(root,'__proto__'),'owned proto name');writeFileSync(join(root,'constructor'),'owned constructor name');const files=collectFiles(root);
 expect(Object.keys(files).sort()).toEqual(['__proto__','constructor']);expect(Object.hasOwn(files,'__proto__')).toBe(true);expect(differences({},files)).toEqual(expect.arrayContaining([expect.objectContaining({path:'__proto__',status:'added',after:'owned proto name'}),expect.objectContaining({path:'constructor',status:'added',after:'owned constructor name'})]));
});
