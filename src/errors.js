export class WtmanError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = 'WtmanError';
    this.exitCode = exitCode;
  }
}

export class SelectionCancelledError extends WtmanError {
  constructor(message = 'selection cancelled') {
    super(message, { exitCode: 130 });
    this.name = 'SelectionCancelledError';
    this.cancelled = true;
  }
}

export function isCommandNotFound(error) {
  return error?.code === 'ENOENT';
}

export function isExitStatus(error, status) {
  return error?.exitCode === status || error?.status === status || error?.code === status;
}
