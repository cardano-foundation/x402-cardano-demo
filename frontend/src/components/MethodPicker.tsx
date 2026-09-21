import type { PaymentMethod } from "../x402/flow";

export interface DemoMethod {
  id: PaymentMethod;
  path: string;
  label: string;
  price: string;
  asset: string;
  amount: string;
}

interface MethodPickerProps {
  methods: DemoMethod[];
  method: PaymentMethod;
  onChange: (method: PaymentMethod) => void;
  disabled?: boolean;
}

/** Route terms come from the resource server so this picker never invents a
 * price, asset, or availability that the next 402 will contradict. */
export function MethodPicker({ methods, method, onChange, disabled }: MethodPickerProps) {
  return (
    <fieldset className="method-picker" disabled={disabled}>
      <legend>Payment route</legend>
      <div className="method-picker__control">
        {methods.map((option) => (
          <label
            key={option.id}
            className="method-picker__option"
            data-selected={method === option.id}
          >
            <input
              type="radio"
              name="payment-method"
              aria-label={`${option.label} ${option.price}`}
              value={option.id}
              checked={method === option.id}
              onChange={() => onChange(option.id)}
            />
            <span>
              <span className="method-picker__option-label">{option.label}</span>
              <span className="method-picker__option-price mono-tag">{option.price}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
