import { spawn, execFile } from 'node:child_process';
export class GitError extends Error {
    constructor(message: string, public status = 400, public uncertain = false, public terminationUnconfirmed = false, public confirmedRejection = false) {
        super(message);
    }
}
export function scrub(value: string) {
    return value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, '[remote]').replace(/\b[^\s/@]+@[^\s/:]+:[^\s]+/g, '[remote]').replace(/(password|token|authorization|credential)[=: ]+\S+/gi, '$1=[redacted]').slice(0, 1500);
}
export interface RunnerOptions {
    timeoutMs?: number;
    maxOutputBytes?: number;
    onSpawn?: (pid: number) => void | Promise<void>;
}
/** Arguments are produced by the service; user paths always follow -- with literal pathspecs. */
export function runGit(root: string, args: string[], options: RunnerOptions = {}, optional = false): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        for (const key of Object.keys(env))
            if (/^(GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_.*|CONFIG_VALUE_.*))$/.test(key))
                delete env[key];
        Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_PAGER: 'cat', PAGER: 'cat', SSH_ASKPASS_REQUIRE: 'never' });
        const child = spawn('git', ['--no-optional-locks', '--literal-pathspecs', ...args], { cwd: root, shell: false, windowsHide: true, detached: process.platform !== 'win32', env });
        const spawned = child.pid ? Promise.resolve().then(() => options.onSpawn?.(child.pid!)) : Promise.resolve();
        void spawned.catch(() => {
        });
        const chunks: Buffer[] = [], errors: Buffer[] = [];
        let size = 0, errorSize = 0, stopReason = '', finished = false, terminationUnconfirmed = false;
        let termination = Promise.resolve();
        let watchdog: NodeJS.Timeout | undefined;
        const stop = (reason: string) => {
            if (stopReason)
                return;
            stopReason = reason;
            termination = new Promise<void>(done => {
                if (process.platform === 'win32' && child.pid) {
                    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }, error => {
                        terminationUnconfirmed = !!error;
                        done();
                    });
                }
                else if (child.pid) {
                    try {
                        process.kill(-child.pid, 'SIGKILL');
                    }
                    catch {
                        terminationUnconfirmed = true;
                    }
                    done();
                }
                else {
                    terminationUnconfirmed = true;
                    done();
                }
            });
            watchdog = setTimeout(() => {
                if (!finished) {
                    finished = true;
                    clearTimeout(timer);
                    reject(new GitError(stopReason, 409, true, true));
                }
            }, 5000);
        };
        const timer = setTimeout(() => stop('Git 실행 시간 제한을 초과했습니다. 상태를 확인하세요.'), options.timeoutMs ?? 30000);
        child.stdout.on('data', (b: Buffer) => {
            size += b.length;
            if (size > (options.maxOutputBytes ?? 8 * 1024 * 1024))
                stop('Git 출력 제한을 초과했습니다.');
            else
                chunks.push(b);
        });
        child.stderr.on('data', (b: Buffer) => {
            errorSize += b.length;
            if (errorSize < 4000)
                errors.push(b);
        });
        child.on('error', (e: NodeJS.ErrnoException) => {
            clearTimeout(timer);
            if (watchdog)
                clearTimeout(watchdog);
            finished = true;
            reject(new GitError(e.code === 'ENOENT' ? 'Git이 설치되어 있지 않습니다.' : scrub(e.message), 503));
        });
        child.on('close', async (code) => {
            clearTimeout(timer);
            await termination;
            if (watchdog)
                clearTimeout(watchdog);
            if (finished)
                return;
            finished = true;
            try {
                await spawned;
            }
            catch {
                reject(new GitError('실행 프로세스 기록을 저장하지 못했습니다.', 409, true, true));
                return;
            }
            if (stopReason)
                reject(new GitError(stopReason, 409, true, terminationUnconfirmed));
            else if (code !== 0 && !optional) {
                const statuses = Buffer.concat(chunks).toString().split('\n').filter(line => /^[=*! +\-]\t/.test(line));
                const rejected = statuses.length === 1 && /^!\t[^\t]+\t\[(?:remote )?rejected\]/.test(statuses[0]);
                reject(new GitError(scrub(Buffer.concat(errors).toString()) || 'Git 작업에 실패했습니다.', 400, false, false, rejected));
            }
            else
                resolve(code !== 0 ? Buffer.alloc(0) : Buffer.concat(chunks));
        });
    });
}
