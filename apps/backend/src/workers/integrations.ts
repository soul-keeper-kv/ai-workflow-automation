import {
  ClaudeCodeAgent,
  FakeCodingAgent,
  WorkspaceFilesystem,
  type CodingAgent,
  type CodingAgentInfo,
} from '@aap/integrations';
import type { Logger } from '@aap/workflow-core';
import type { AppConfig } from '../config/env.js';

export interface Integrations {
  filesystem: WorkspaceFilesystem;
  codingAgent: CodingAgent;
  /** Probed once at startup. Restart the app after installing or logging in to the CLI. */
  codingAgentInfo: CodingAgentInfo;
  workspaceRoots: readonly string[];
}

function createCodingAgent(config: AppConfig): CodingAgent {
  if (config.codingAgent.kind === 'fake') return new FakeCodingAgent({ delayMs: 1_500 });
  return new ClaudeCodeAgent({
    ...(config.codingAgent.executable === undefined
      ? {}
      : { executable: config.codingAgent.executable }),
    ...(config.codingAgent.model === undefined ? {} : { model: config.codingAgent.model }),
    ...(config.codingAgent.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: config.codingAgent.maxBudgetUsd }),
  });
}

/** Builds the adapters workflows use. Fails at startup if a workspace root is invalid. */
export async function createIntegrations(config: AppConfig, logger: Logger): Promise<Integrations> {
  const filesystem = await WorkspaceFilesystem.create(config.workspaceRoots);
  const codingAgent = createCodingAgent(config);
  const codingAgentInfo = await codingAgent.probe();
  logger.info(
    {
      codingAgent: codingAgentInfo.id,
      available: codingAgentInfo.available,
      version: codingAgentInfo.version,
      reason: codingAgentInfo.reason,
      workspaceRoots: filesystem.roots,
    },
    'Integrations ready',
  );
  return { filesystem, codingAgent, codingAgentInfo, workspaceRoots: filesystem.roots };
}
