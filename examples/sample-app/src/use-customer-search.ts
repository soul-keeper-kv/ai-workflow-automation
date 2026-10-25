import { useState } from 'react';
import type { SearchCriteria } from './validation';

export interface Customer {
  id: string;
  name: string;
  country: string;
  active: boolean;
  lastOrderAt: string | null;
}

type SearchState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'done'; results: Customer[] }
  | { state: 'error'; error: string };

export function useCustomerSearch() {
  const [status, setStatus] = useState<SearchState>({ state: 'idle' });

  const run = async (criteria: SearchCriteria) => {
    setStatus({ state: 'loading' });
    const params = new URLSearchParams({
      name: criteria.name,
      ...(criteria.country ? { country: criteria.country } : {}),
      active: String(criteria.activeOnly),
    });
    try {
      const response = await fetch(`/api/customers?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { items: Customer[] };
      setStatus({ state: 'done', results: body.items });
    } catch (error) {
      setStatus({ state: 'error', error: error instanceof Error ? error.message : 'unknown' });
    }
  };

  return {
    ...status,
    results: status.state === 'done' ? status.results : [],
    error: status.state === 'error' ? status.error : null,
    run,
  };
}
