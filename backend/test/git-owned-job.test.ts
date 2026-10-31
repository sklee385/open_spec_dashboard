import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGit, type RunnerOptions } from '../src/projects/git-runner';

it('소유 Git Job은 입력 전 PID를 기록하고 독립 자손의 실제 종료 뒤에만 반환한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-owned-')), marker = join(root, 'leaf.txt');
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, windowsHide: true, stdio: 'ignore' });
  const leaf = join(root, 'leaf.cjs'), actor = join(root, 'actor.cjs');
  writeFileSync(leaf, "const fs=require('node:fs');const p=process.argv[2];fs.appendFileSync(p,'alive'+String.fromCharCode(10));setInterval(()=>fs.appendFileSync(p,'alive'+String.fromCharCode(10)),20);setTimeout(()=>process.exit(0),2000);");
  writeFileSync(actor, "const cp=require('node:child_process');const fs=require('node:fs');const p=cp.spawn(process.execPath,[process.argv[2],process.argv[3]],{detached:true,stdio:'ignore'});p.unref();setTimeout(()=>process.exit(3),3000);const t=setInterval(()=>{if(fs.existsSync(process.argv[3])){clearInterval(t);process.exit(0)}},10);");
  let spawned = 0, proof: any;
  const options: RunnerOptions & { ownedJob: true } = { ownedJob: true, timeoutMs: 10000,
    onSpawn: pid => { spawned = pid; expect(existsSync(marker)).toBe(false); },
    onTermination: evidence => { proof = evidence; } };
  const quote = (path: string) => '"' + path.split(String.fromCharCode(92)).join('/') + '"';
  await runGit(root, ['-c', 'alias.owned=!' + [process.execPath, actor, leaf, marker].map(quote).join(' '), 'owned'], options);
  expect(spawned).toBeGreaterThan(0); expect(proof).toMatchObject({ protocol: 'owned-git-job-v1', state: 'job-quiescent', workerPid: spawned });
  const before = readFileSync(marker, 'utf8'); await new Promise(resolve => setTimeout(resolve, 140));
  expect(readFileSync(marker, 'utf8')).toBe(before);
}, 25000);
