import { WorkflowDefinitionError, WorkflowNotFoundError } from '../contracts/errors.js';
import type { Workflow } from '../contracts/workflow.js';

/**
 * The set of workflows this app can run. Built once at startup from an explicit list, so the
 * catalog is the same on every start. Nothing is loaded dynamically or from API input.
 */
export class WorkflowRegistry {
  readonly #workflows = new Map<string, Workflow>();

  constructor(workflows: readonly Workflow[] = []) {
    for (const workflow of workflows) this.register(workflow);
  }

  register(workflow: Workflow): void {
    if (this.#workflows.has(workflow.id)) {
      throw new WorkflowDefinitionError(`Workflow id "${workflow.id}" is already registered.`);
    }
    this.#workflows.set(workflow.id, workflow);
  }

  get(id: string): Workflow | undefined {
    return this.#workflows.get(id);
  }

  require(id: string): Workflow {
    const workflow = this.#workflows.get(id);
    if (workflow === undefined) throw new WorkflowNotFoundError(id);
    return workflow;
  }

  /** In registration order. */
  list(): Workflow[] {
    return [...this.#workflows.values()];
  }
}
