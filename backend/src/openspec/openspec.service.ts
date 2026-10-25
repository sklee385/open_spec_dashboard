import { BadRequestException, Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

@Injectable()
export class OpenSpecService {
  private cli() {
    let dir = __dirname;
    while (dirname(dir) !== dir) {
      const file = resolve(dir, 'node_modules/@fission-ai/openspec/package.json');
      if (existsSync(file)) { const pkg = JSON.parse(readFileSync(file, 'utf8')); return resolve(dirname(file), pkg.bin.openspec); }
      dir = dirname(dir);
    }
    throw new Error('프로젝트의 OpenSpec CLI를 찾을 수 없습니다');
  }
  run(cwd: string, args: string[]): Promise<{ ok: boolean; code: number; stdout: string; stderr: string; json?: any }> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [this.cli(), ...args], { cwd, shell: false, windowsHide: true, env: { ...process.env, OPENSPEC_TELEMETRY: '0' } });
      let stdout = '', stderr = '', timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
      const collect = (chunk: Buffer, target: 'out' | 'err') => { if (target === 'out') stdout += chunk; else stderr += chunk; if (stdout.length + stderr.length > 4000000) child.kill(); };
      child.stdout.on('data', chunk => collect(chunk, 'out')); child.stderr.on('data', chunk => collect(chunk, 'err'));
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); let json: any; try { json = JSON.parse(stdout); } catch {} resolveResult({ ok: code === 0 && !timedOut, code: code ?? -1, stdout, stderr: timedOut ? `${stderr}\nCLI 시간 초과` : stderr, json }); });
    });
  }
  inspect(cwd: string, change: string, operation: string, artifact?: string) {
    const args: Record<string, string[]> = {
      status: ['status', '--change', change, '--json'],
      schemas: ['schemas', '--json'],
      specs: ['list', '--specs', '--json'],
      deltas: ['show', change, '--type', 'change', '--deltas-only', '--json'],
      diff: ['show', change, '--type', 'change', '--diff'],
      validate: ['validate', change, '--strict'],
      doctor: ['doctor', '--json'],
      context: ['context', '--json'],
    };
    if (operation === 'instructions') {
      if (!artifact || !/^[a-z][a-z0-9-]*$/.test(artifact)) throw new BadRequestException('산출물 또는 동작 이름이 필요합니다');
      return this.run(cwd, ['instructions', artifact, '--change', change, '--json']);
    }
    if (operation === 'spec') {
      if (!artifact || !/^[a-z0-9][a-z0-9/-]*$/.test(artifact) || artifact.includes('//')) throw new BadRequestException('기준 명세 이름이 필요합니다');
      return this.run(cwd, ['show', artifact, '--type', 'spec', '--json']);
    }
    if (!args[operation]) throw new BadRequestException('지원하지 않는 OpenSpec 동작입니다');
    return this.run(cwd, args[operation]);
  }
}
