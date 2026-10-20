// Shown instantly while any admin page loads its data (Suspense fallback for the admin segment).
export default function AdminLoading() {
  return (
    <main className="admin-main" aria-busy="true">
      <div role="status" className="loading-status">
        <span className="spinner" aria-hidden="true" />
        <span>Loading…</span>
      </div>
      <div className="skeleton skeleton-title" aria-hidden="true" />
      <ul className="skeleton-list" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <li key={index} className="skeleton skeleton-row" />
        ))}
      </ul>
    </main>
  );
}
