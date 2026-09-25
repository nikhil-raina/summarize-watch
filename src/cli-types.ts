export interface GlobalOptions {
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
}

/** A user-facing failure: message printed as-is, process exits with `exitCode`. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
