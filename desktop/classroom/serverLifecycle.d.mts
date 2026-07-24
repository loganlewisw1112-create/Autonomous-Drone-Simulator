// Types for desktop/classroom/serverLifecycle.mjs so Electron lifecycle helpers can be
// unit-tested from src/tests/ under `tsc -b` without allowJs for the whole project.

export declare const DEFAULT_CLASSROOM_PORT: number
export declare const HEALTH_PATH: string

export type ClassroomProbeResult =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: string }

export declare function classroomBaseUrl(port?: string | number): string

export declare function buildServerEnv(
  baseEnv?: NodeJS.ProcessEnv,
  opts?: { electronAsNode?: boolean },
): NodeJS.ProcessEnv

export declare function spawnClassroomServer(opts: {
  command: string
  scriptPath: string
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  spawnFn?: (...args: never[]) => { pid?: number }
}): { pid?: number }

export declare function probeClassroomServer(
  baseUrl: string,
  opts?: { fetchFn?: typeof fetch; timeoutMs?: number },
): Promise<ClassroomProbeResult>

export declare function waitForClassroomServer(
  baseUrl: string,
  opts?: {
    timeoutMs?: number
    intervalMs?: number
    probe?: (baseUrl: string) => Promise<ClassroomProbeResult>
    sleep?: (ms: number) => Promise<void>
  },
): Promise<ClassroomProbeResult>

export declare function stopClassroomServer(
  child: { kill?: (signal?: string) => void; pid?: number; killed?: boolean; exitCode?: number | null } | null | undefined,
  opts?: {
    platform?: NodeJS.Platform
    killTreeFn?: (pid: number) => void
    killFn?: (child: unknown, signal?: string) => void
  },
): { stopped: boolean; alreadyDead: boolean }
