export interface ConfirmationRange {
  minimum: number;
  maximum: number;
}

interface SettlementOptionsProps {
  value: number;
  range: ConfirmationRange;
  onChange: (next: number) => void;
  disabled?: boolean;
  syncing?: boolean;
  syncError?: string | null;
}

/** One server-submitted settlement control, bounded by the facilitator's live
 * capability response. */
export function SettlementOptions({
  value,
  range,
  onChange,
  disabled,
  syncing,
  syncError,
}: SettlementOptionsProps) {
  const choices = Array.from(
    { length: Math.max(0, range.maximum - range.minimum + 1) },
    (_, index) => range.minimum + index,
  );

  return (
    <div className="settlement-options">
      <div className="settlement-options__group">
        <label className="settlement-options__label" htmlFor="l1-confirmations">
          Confirmations before unlock
        </label>
        <select
          id="l1-confirmations"
          value={value}
          disabled={disabled || syncing}
          onChange={(event) => onChange(Number(event.target.value))}
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {confirmationLabel(choice)}
            </option>
          ))}
        </select>
        <p className="step-note">{describeConfirmations(value)}</p>
      </div>

      {syncing && (
        <p className="control-panel__hint control-panel__hint--muted" role="status">
          Updating the server…
        </p>
      )}
      {syncError && (
        <p className="control-panel__error" role="alert">
          Could not update confirmations: {syncError}
        </p>
      )}
    </div>
  );
}

function confirmationLabel(value: number): string {
  if (value === -1) return "Facilitator acceptance";
  if (value === 0) return "Block inclusion";
  if (value === 1) return "1 confirmation";
  return `${value} confirmations`;
}

function describeConfirmations(value: number): string {
  if (value === -1) return "Unlock when the facilitator accepts the transaction for settlement, before block inclusion.";
  if (value === 0) return "Unlock after the payment appears in a canonical block.";
  if (value === 1) return "Unlock after one newer block builds on the payment block.";
  return `Unlock after ${value} newer blocks build on the payment block.`;
}
