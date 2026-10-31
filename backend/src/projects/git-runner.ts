import { spawn, execFileSync } from 'node:child_process';
import { guardBrowserProcess, guardWorkerPath } from '../browser/browser-job';
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
    ownedJob?: true;
    onSpawn?: (pid: number) => void | Promise<void>;
    /** Internal-only: the caller pins this path/ref from its owned source checkpoint. */
    headPin?: { file: string; ref: string; beforeDispatch: () => void | Promise<void> };
    onTermination?: (evidence: { protocol: 'head-pin-job-v1' | 'owned-git-job-v1'; state: 'job-quiescent' | 'not-dispatched'; workerPid: number | null; guardPid?: number; at: string }) => void | Promise<void>;
}
export function gitEnvironment() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_.*|CONFIG_VALUE_.*))$/.test(key.toUpperCase())) delete env[key];
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_PAGER: 'cat', PAGER: 'cat', SSH_ASKPASS_REQUIRE: 'never' });
    return env;
}
/** Bounded read-only checks for existing synchronous workspace path consumers. */
export function readGitBufferSync(root: string, args: string[], input?: Buffer) {
    try { return execFileSync('git', ['--no-optional-locks', '--literal-pathspecs', ...args], { cwd: root, windowsHide: true, env: gitEnvironment(), timeout: 10000, maxBuffer: 4 * 1024 * 1024, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch { throw new GitError('Git 공간 등록을 확인할 수 없습니다. 실제 상태 복구가 필요합니다.', 409); }
}
export function readGitSync(root: string, args: string[]) { return readGitBufferSync(root, args).toString('utf8'); }
/** Arguments are produced by the service; user paths always follow -- with literal pathspecs. */
export function runGit(root: string, args: string[], options: RunnerOptions = {}, optional = false): Promise<Buffer> {
    if (options.headPin || options.ownedJob) return runOwnedGit(root, args, options, optional);
    return new Promise((resolve, reject) => {
        const env = gitEnvironment();
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
                if (process.platform === 'win32') {
                    // A retained ChildProcess handle identifies only this child; its exit
                    // cannot prove termination of descendants of an unguarded read.
                    terminationUnconfirmed = true;
                    try { child.kill(); } catch { /* Keep uncertainty. */ }
                    done();
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

/** Git starts after owned-worker persistence and Job identity; source apply also pins HEAD. */
async function runOwnedGit(root: string, args: string[], options: RunnerOptions, optional: boolean): Promise<Buffer> {
    if (process.platform !== 'win32') throw new GitError('소유 Git Job과 native HEAD 보호는 현재 Windows에서만 지원합니다', 409);
    const env = gitEnvironment(), workerEnv = { ...env };
    for (const key of Object.keys(workerEnv)) if (key.toUpperCase().startsWith('GIT_') || ['NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CONFIG_PATH', 'WORKSPACE_ROOT', 'DESKTOP_TOKEN', 'OPENSPEC_NODE_DIRECTORY'].includes(key.toUpperCase())) delete workerEnv[key];
    for (const key of Object.keys(env)) if (['NODE_OPTIONS', 'NODE_PATH', 'DATA_DIR', 'CONFIG_PATH', 'WORKSPACE_ROOT', 'DESKTOP_TOKEN', 'OPENSPEC_NODE_DIRECTORY'].includes(key.toUpperCase())) delete env[key];
    const worker = "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>{s+=b;if(s.length>2000000)process.exit(2)});process.stdin.on('end',()=>{try{const c=JSON.parse(s);const p=require('child_process').spawn('git',c.args,{cwd:process.cwd(),env:c.env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});p.stdout.pipe(process.stdout);p.stderr.pipe(process.stderr);p.once('error',()=>process.exit(127));p.once('close',n=>process.exit(Number.isInteger(n)?n:1));}catch{process.exit(2)}});";
    const child = spawn(process.execPath, ['--require', guardWorkerPath(), '-e', worker], { cwd: root, env: workerEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    let code: number | null = null, closedFlag = false, dispatched = false, total = 0, failure = '';
    const out: Buffer[] = [], err: Buffer[] = [];
    const closed = new Promise<void>(resolve => { child.once('error', () => { closedFlag = true; resolve(); }); child.once('close', value => { code = value; closedFlag = true; resolve(); }); });
    // Kill only this live waiting worker. Its supervisor drains the entire owned Job.
    const stop = () => { if (!closedFlag) child.kill(); };
    const output = (target: Buffer[], bytes: Buffer) => { total += bytes.length; if (total > (options.maxOutputBytes ?? 8 * 1024 * 1024)) { failure = 'Git 출력 제한을 초과했습니다'; stop(); } else target.push(bytes); };
    child.stdout!.on('data', bytes => output(out, bytes)); child.stderr!.on('data', bytes => output(err, bytes)); child.stdin!.on('error', () => { failure ||= 'Git 대기 실행기 전송을 확인하지 못했습니다'; stop(); });
    const timer = setTimeout(() => { failure = 'Git 실행 시간 제한을 초과했습니다'; stop(); }, options.timeoutMs ?? 30000);
    const guard = options.headPin ? guardBrowserProcess(child, { file: options.headPin.file, ref: options.headPin.ref }) : guardBrowserProcess(child, undefined, { browserProtocol: true }); void guard.catch(() => {});
    let owned: Awaited<typeof guard> | undefined, quiescent = false, reported = false;
    const report = async () => {
        if (reported || dispatched && !quiescent) return;
        reported = true;
        await options.onTermination?.({ protocol: options.headPin ? 'head-pin-job-v1' : 'owned-git-job-v1', state: quiescent ? 'job-quiescent' : 'not-dispatched', workerPid: child.pid ?? null, ...(owned?.pid ? { guardPid: owned.pid } : {}), at: new Date().toISOString() });
    };
    try {
        if (!child.pid) throw new GitError('Git 대기 실행기 PID가 없습니다', 409);
        await options.onSpawn?.(child.pid);
        owned = await guard;
        await options.headPin?.beforeDispatch();
        if (closedFlag || failure) throw new GitError(failure || 'Git 대기 실행기가 종료되었습니다', 409);
        dispatched = true; child.stdin!.end(JSON.stringify({ args: ['--no-optional-locks', '--literal-pathspecs', ...args], env }));
        await closed; await owned.done; quiescent = true; await report();
        if (failure) throw new GitError(failure, 409, true, false);
        if (code !== 0 && !optional) throw new GitError(scrub(Buffer.concat(err).toString()) || 'Git 작업에 실패했습니다', 400);
        return code === 0 ? Buffer.concat(out) : Buffer.alloc(0);
    } catch (error: any) {
        stop(); await closed;
        let terminated = !dispatched;
        try { owned ??= await guard; await owned.done; quiescent = true; terminated = true; } catch { /* Never release a dispatched Git Job based only on worker close. */ }
        if (terminated) try { await report(); } catch { /* The caller may still persist its in-memory witness with the result. */ }
        if (error instanceof GitError && terminated) { error.terminationUnconfirmed = false; throw error; }
        throw new GitError(error instanceof Error ? error.message : 'Git 소유 실행을 확인할 수 없습니다', 409, dispatched, !terminated);
    } finally { clearTimeout(timer); }
}
