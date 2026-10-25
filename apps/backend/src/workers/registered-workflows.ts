import type { Workflow } from '@aap/workflow-core';
import { demoSequenceWorkflow } from '@aap/workflow-demo';

/**
 * Every workflow this app can run, in catalog order. An explicit list, so registration is the
 * same on every start and nothing is loaded from disk or from API input.
 */
export const REGISTERED_WORKFLOWS: readonly Workflow[] = [demoSequenceWorkflow];
