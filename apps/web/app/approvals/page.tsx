export default function Approvals() {
  return (
    <>
      <div className="heading">
        <div>
          <div className="eyebrow">Safety gate</div>
          <h1>Approvals</h1>
          <p className="muted">Risky actions will always wait for explicit approval.</p>
        </div>
      </div>
      <section className="panel">
        <div className="empty">Nothing needs approval</div>
      </section>
    </>
  );
}
