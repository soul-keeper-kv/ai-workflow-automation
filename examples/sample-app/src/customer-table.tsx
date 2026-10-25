import type { Customer } from './use-customer-search';

export function CustomerTable({ customers }: { customers: Customer[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Country</th>
          <th>Status</th>
          <th>Last order</th>
        </tr>
      </thead>
      <tbody>
        {customers.map((customer) => (
          <tr key={customer.id}>
            <td>{customer.name}</td>
            <td>{customer.country}</td>
            <td>{customer.active ? 'Active' : 'Inactive'}</td>
            <td>{customer.lastOrderAt ?? 'Never'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
