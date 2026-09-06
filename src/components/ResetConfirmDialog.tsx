/**
 * The "reset all settings and restart" confirmation. Names exactly what goes and states
 * plainly that confirming reloads the page — a reset with no warning is the kind of
 * thing a player hits by accident once and never trusts the menu again.
 */
export function ResetConfirmDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="reset-confirm-dialog" role="dialog" aria-modal="true" aria-label="Reset all settings">
      <div className="panel-heading">
        <div><small>RESET</small><h2>Reset all settings</h2></div>
        <button type="button" aria-label="Cancel reset" onClick={onCancel}>×</button>
      </div>
      <p>
        This clears render quality, camera and sky preferences, then
        reloads the game with default settings. It does not touch anything outside Svartaksi's
        own settings.
      </p>
      <div className="reset-confirm-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="reset-confirm-confirm" onClick={onConfirm}>
          Reset and restart
        </button>
      </div>
    </section>
  );
}
