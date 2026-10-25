import { EXECUTION_STATUSES, TERMINAL_EXECUTION_STATUSES } from '@aap/shared';
import { describe, expect, it } from 'vitest';
import {
  InvalidStatusTransitionError,
  WorkflowDefinitionError,
  WorkflowNotFoundError,
  WorkflowRegistry,
  assertStatusTransition,
  canTransitionStatus,
  planRecovery,
} from '../src/index.js';
import { createSequenceWorkflow } from './fixtures/sequence-workflow.js';

describe('WorkflowRegistry', () => {
  it('registers workflows and lists them in registration order', () => {
    const registry = new WorkflowRegistry([createSequenceWorkflow()]);

    expect(registry.list().map((w) => w.id)).toEqual(['test-sequence']);
    expect(registry.get('test-sequence')?.version).toBe('1.0.0');
  });

  it('rejects a duplicate workflow id', () => {
    const registry = new WorkflowRegistry([createSequenceWorkflow()]);

    expect(() => registry.register(createSequenceWorkflow({}, '2.0.0'))).toThrow(
      WorkflowDefinitionError,
    );
  });

  it('throws WorkflowNotFoundError for an unknown id', () => {
    expect(() => new WorkflowRegistry().require('nope')).toThrow(WorkflowNotFoundError);
  });
});

describe('execution lifecycle', () => {
  it.each([
    ['PENDING', 'RUNNING'],
    ['RUNNING', 'WAITING_FOR_APPROVAL'],
    ['WAITING_FOR_APPROVAL', 'RUNNING'],
    ['RUNNING', 'COMPLETED'],
    ['RUNNING', 'INTERRUPTED'],
    ['INTERRUPTED', 'RUNNING'],
    ['PENDING', 'CANCELLED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransitionStatus(from, to)).toBe(true);
  });

  it.each([
    ['PENDING', 'COMPLETED'],
    ['PENDING', 'WAITING_FOR_APPROVAL'],
    ['WAITING_FOR_APPROVAL', 'COMPLETED'],
    ['INTERRUPTED', 'COMPLETED'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(() => assertStatusTransition(from, to)).toThrow(InvalidStatusTransitionError);
  });

  it('never leaves a terminal status', () => {
    for (const from of TERMINAL_EXECUTION_STATUSES) {
      for (const to of EXECUTION_STATUSES) {
        expect(canTransitionStatus(from, to)).toBe(false);
      }
    }
  });
});

describe('planRecovery', () => {
  it('resumes an execution that stopped between steps', () => {
    expect(planRecovery({ status: 'RUNNING' }, null)).toEqual({ action: 'resume' });
  });

  it('interrupts an execution whose step was running, without re-running it', () => {
    const plan = planRecovery({ status: 'RUNNING' }, { stepId: 'IMPLEMENT' });

    expect(plan.action).toBe('interrupt');
    expect(plan.action === 'interrupt' && plan.error.code).toBe('INTERRUPTED');
  });
});
