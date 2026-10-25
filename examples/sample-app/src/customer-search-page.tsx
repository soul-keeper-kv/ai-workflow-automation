// Sample input for the Generate Spec workflow. Written for this repository; not production code.
import { useState, type FormEvent } from 'react';
import { CustomerTable } from './customer-table';
import { useCustomerSearch } from './use-customer-search';
import { validateSearch, type SearchCriteria } from './validation';

const EMPTY: SearchCriteria = { name: '', country: '', activeOnly: true };

export default function CustomerSearchPage() {
  const [criteria, setCriteria] = useState<SearchCriteria>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const search = useCustomerSearch();

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found = validateSearch(criteria);
    setErrors(found);
    if (Object.keys(found).length === 0) void search.run(criteria);
  };

  return (
    <main>
      <h1>Customer search</h1>
      <form onSubmit={onSubmit} noValidate>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          required
          minLength={2}
          maxLength={80}
          value={criteria.name}
          onChange={(e) => setCriteria({ ...criteria, name: e.target.value })}
        />
        {errors.name ? <p role="alert">{errors.name}</p> : null}

        <label htmlFor="country">Country code</label>
        <input
          id="country"
          maxLength={2}
          placeholder="VN"
          value={criteria.country}
          onChange={(e) => setCriteria({ ...criteria, country: e.target.value.toUpperCase() })}
        />
        {errors.country ? <p role="alert">{errors.country}</p> : null}

        <label>
          <input
            type="checkbox"
            checked={criteria.activeOnly}
            onChange={(e) => setCriteria({ ...criteria, activeOnly: e.target.checked })}
          />
          Active customers only
        </label>

        <button type="submit" disabled={search.state === 'loading'}>
          Search
        </button>
        <button type="button" onClick={() => setCriteria(EMPTY)}>
          Clear
        </button>
      </form>

      {search.state === 'loading' ? <p>Searching…</p> : null}
      {search.state === 'error' ? <p role="alert">Search failed: {search.error}</p> : null}
      {search.state === 'done' && search.results.length === 0 ? <p>No customers match.</p> : null}
      {search.state === 'done' && search.results.length > 0 ? (
        <CustomerTable customers={search.results} />
      ) : null}
    </main>
  );
}
