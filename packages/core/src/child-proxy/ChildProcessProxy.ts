import * as os from 'os';
import { fork, ChildProcess } from 'child_process';
import { File, StrykerOptions } from '@stryker-mutator/api/core';
import { getLogger } from 'log4js';
import { WorkerMessage, WorkerMessageKind, ParentMessage, autoStart, ParentMessageKind } from './messageProtocol';
import { serialize, deserialize, kill, padLeft } from '../utils/objectUtils';
import { Task, ExpirableTask } from '../utils/Task';
import LoggingClientContext from '../logging/LoggingClientContext';
import ChildProcessCrashedError from './ChildProcessCrashedError';
import { isErrnoException } from '@stryker-mutator/util';
import OutOfMemoryError from './OutOfMemoryError';
import StringBuilder from '../utils/StringBuilder';
import { InjectionToken, InjectableClass, Disposable } from 'typed-inject';
import { OptionsContext } from '@stryker-mutator/api/plugin';

type Func<TS extends any[], R> = (...args: TS) => R;

type PromisifiedFunc<TS extends any[], R> = (...args: TS) => Promise<R>;

export type Promisified<T> = {
  [K in keyof T]: T[K] extends PromisifiedFunc<any, any> ? T[K] : T[K] extends Func<infer TS, infer R> ? PromisifiedFunc<TS, R> : () => Promise<T[K]>;
};

const BROKEN_PIPE_ERROR_CODE = 'EPIPE';
const IPC_CHANNEL_CLOSED_ERROR_CODE = 'ERR_IPC_CHANNEL_CLOSED';
const TIMEOUT_FOR_DISPOSE = 2000;

export default class ChildProcessProxy<T> implements Disposable {
  public readonly proxy: Promisified<T>;

  private readonly worker: ChildProcess;
  private readonly initTask: Task;
  private disposeTask: ExpirableTask<void> | undefined;
  private currentError: ChildProcessCrashedError | undefined;
  private readonly workerTasks: Task<void>[] = [];
  private readonly log = getLogger(ChildProcessProxy.name);
  private readonly stdoutBuilder = new StringBuilder();
  private readonly stderrBuilder = new StringBuilder();
  private isDisposed = false;

  private constructor(requirePath: string, requireName: string, loggingContext: LoggingClientContext, options: StrykerOptions, additionalInjectableValues: unknown, workingDirectory: string) {
    this.worker = fork(require.resolve('./ChildProcessProxyWorker'), [autoStart], { silent: true, execArgv: [] });
    this.initTask = new Task();
    this.log.debug('Starting %s in child process %s', requirePath, this.worker.pid);
    this.send({
      additionalInjectableValues,
      kind: WorkerMessageKind.Init,
      loggingContext,
      options,
      requireName,
      requirePath,
      workingDirectory
    });
    this.listenForMessages();
    this.listenToStdoutAndStderr();
    // Listen to `close`, not `exit`, see https://github.com/stryker-mutator/stryker/issues/1634
    this.worker.on('close', this.handleUnexpectedExit);
    this.worker.on('error', this.handleError);
    this.proxy = this.initProxy();
  }

  /**
   * @description Creates a proxy where each function of the object created using the constructorFunction arg is ran inside of a child process
   */
  public static create<TAdditionalContext, R, Tokens extends InjectionToken<OptionsContext & TAdditionalContext>[]>(
    requirePath: string,
    loggingContext: LoggingClientContext,
    options: StrykerOptions,
    additionalInjectableValues: TAdditionalContext,
    workingDirectory: string,
    InjectableClass: InjectableClass<TAdditionalContext & OptionsContext, R, Tokens>):
    ChildProcessProxy<R> {
    return new ChildProcessProxy(requirePath, InjectableClass.name, loggingContext, options, additionalInjectableValues, workingDirectory);
  }

  private send(message: WorkerMessage) {
    this.worker.send(serialize(message, [File]));
  }

  private initProxy(): Promisified<T> {
    // This proxy is a genuine javascript `Proxy` class
    // More info: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy
    const self = this;
    return new Proxy({} as Promisified<T>, {
      get(_, propertyKey) {
        if (typeof propertyKey === 'string') {
          return self.forward(propertyKey);
        } else {
          return undefined;
        }
      }
    });
  }

  private forward(methodName: string) {
    return (...args: any[]) => {
      if (this.currentError) {
        return Promise.reject(this.currentError);
      } else {
        const workerTask = new Task<void>();
        const correlationId = this.workerTasks.push(workerTask) - 1;
        this.initTask.promise.then(() => {
          this.send({
            args,
            correlationId,
            kind: WorkerMessageKind.Call,
            methodName
          });
        });
        return workerTask.promise;
      }
    };
  }

  private listenForMessages() {
    this.worker.on('message', (serializedMessage: string) => {
      const message: ParentMessage = deserialize(serializedMessage, [File]);
      switch (message.kind) {
        case ParentMessageKind.Initialized:
          this.initTask.resolve(undefined);
          break;
        case ParentMessageKind.Result:
          this.workerTasks[message.correlationId].resolve(message.result);
          delete this.workerTasks[message.correlationId];
          break;
        case ParentMessageKind.Rejection:
          this.workerTasks[message.correlationId].reject(new Error(message.error));
          delete this.workerTasks[message.correlationId];
          break;
        case ParentMessageKind.DisposeCompleted:
          if (this.disposeTask) {
            this.disposeTask.resolve(undefined);
          }
          break;
        default:
          this.logUnidentifiedMessage(message);
          break;
      }
    });
  }

  private listenToStdoutAndStderr() {
    const handleData = (builder: StringBuilder) => (data: Buffer | string) => {
      const output = data.toString();
      builder.append(output);
      if (this.log.isTraceEnabled()) {
        this.log.trace(output);
      }
    };

    if (this.worker.stdout) {
      this.worker.stdout.on('data', handleData(this.stdoutBuilder));
    }

    if (this.worker.stderr) {
      this.worker.stderr.on('data', handleData(this.stderrBuilder));
    }
  }

  private reportError(error: Error) {
    this.workerTasks
      .filter(task => !task.isCompleted)
      .forEach(task => task.reject(error));
  }

  private readonly handleUnexpectedExit = (code: number, signal: string) => {
    this.isDisposed = true;
    const output = StringBuilder.concat(this.stderrBuilder, this.stdoutBuilder);

    if (processOutOfMemory()) {
      this.currentError = new OutOfMemoryError(this.worker.pid, code);
      this.log.warn(`Child process [pid ${this.currentError.pid}] ran out of memory. Stdout and stderr are logged on debug level.`);
      this.log.debug(stdoutAndStderr());
    } else {
      this.currentError = new ChildProcessCrashedError(this.worker.pid, `Child process [pid ${this.worker.pid}] exited unexpectedly with exit code ${code} (${signal || 'without signal'}). ${stdoutAndStderr()}`, code, signal);
      this.log.warn(this.currentError.message, this.currentError);
    }

    this.reportError(this.currentError);

    function processOutOfMemory() {
      return output.indexOf('JavaScript heap out of memory') >= 0;
    }

    function stdoutAndStderr() {
      if (output.length) {
        return `Last part of stdout and stderr was:${os.EOL}${padLeft(output)}`;
      } else {
        return 'Stdout and stderr were empty.';
      }
    }
  }

  private readonly handleError = (error: Error) => {
    if (this.innerProcessIsCrashed(error)) {
      this.log.warn(`Child process [pid ${this.worker.pid}] has crashed. See other warning messages for more info.`, error);
      this.reportError(new ChildProcessCrashedError(this.worker.pid, `Child process [pid ${this.worker.pid}] has crashed`, undefined, undefined, error));
    } else {
      this.reportError(error);
    }
  }

  private innerProcessIsCrashed(error: Error) {
    return isErrnoException(error) && (error.code === BROKEN_PIPE_ERROR_CODE || error.code === IPC_CHANNEL_CLOSED_ERROR_CODE);
  }

  public async dispose(): Promise<void> {
    if (!this.isDisposed) {
      this.worker.removeListener('close', this.handleUnexpectedExit);
      this.isDisposed = true;
      this.log.debug('Disposing of worker process %s', this.worker.pid);
      this.disposeTask = new ExpirableTask(TIMEOUT_FOR_DISPOSE);
      this.send({ kind: WorkerMessageKind.Dispose });
      try {
        await this.disposeTask.promise;
      } finally {
          this.log.debug('Kill %s', this.worker.pid);
          await kill(this.worker.pid);
      }
    }
  }

  private logUnidentifiedMessage(message: never) {
    this.log.error(`Received unidentified message ${message}`);
  }
}
