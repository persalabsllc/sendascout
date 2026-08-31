export type BuildEnvironment = Record<string, string | undefined>;

export type BuildRunner = (
  command: string,
  args: string[],
  environment: BuildEnvironment,
) => Promise<void>;

export function shouldMigrateProduction(environment?: BuildEnvironment): boolean;

export function runVercelBuild(options?: {
  environment?: BuildEnvironment;
  runner?: BuildRunner;
}): Promise<void>;
