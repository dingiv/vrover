import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runTask } from './agent.js';

/**
 * The CLI frontend — a one-shot task runner. Takes the task from `--task`, an interactive
 * prompt (TTY), or piped stdin; streams the agent's progress; prints the result and sets
 * the exit code from the task status. Shares {@link runTask} with the web frontend.
 */
export interface CliOptions {
  scoutHost: string;
  scoutPort: number;
  task?: string;
  maxSteps?: number;
}

export async function runCli(opts: CliOptions): Promise<void> {
  const task = await resolveTask(opts.task);
  if (!task) {
    console.error('No task provided. Pass --task, type one at the prompt, or pipe it on stdin.');
    process.exitCode = 2;
    return;
  }

  console.log(`Driving Visual Scout at ${opts.scoutHost}:${opts.scoutPort}`);
  console.log(`Task: ${task}\n`);

  let outcome;
  try {
    outcome = await runTask({
      scoutHost: opts.scoutHost,
      scoutPort: opts.scoutPort,
      task,
      maxSteps: opts.maxSteps,
      log: (line) => console.log(line),
    });
  } catch (err) {
    console.error(`\n✗ ${errMsg(err)}`);
    process.exitCode = 1;
    return;
  }

  const { result } = outcome;
  console.log('\n=== RESULT ===');
  console.log('status:', result.status, '| steps:', result.steps.length);
  if (result.summary) console.log('summary:', result.summary);
  if (result.error) console.log('error:', result.error);
  console.log(result.status === 'success' ? '\n✓ Task completed.' : '\n✗ Task did not complete.');
  process.exitCode = result.status === 'success' ? 0 : 1;
}

/** `--task` wins; else prompt on a TTY, else read piped stdin. */
async function resolveTask(task?: string): Promise<string | undefined> {
  const fromFlag = task?.trim();
  if (fromFlag) return fromFlag;
  if (stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question('Describe the task: ')).trim() || undefined;
    } finally {
      rl.close();
    }
  }
  return (await readAllStdin()).trim() || undefined;
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    stdin.on('end', () => resolve(data));
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
