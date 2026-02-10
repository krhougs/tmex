import * as React from 'react';
import { ChevronDown } from 'lucide-react';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = '', children, ...props }, ref) => {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={`flex h-9 w-full appearance-none rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1 pr-8 text-sm text-[var(--color-text)] shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)] pointer-events-none" />
      </div>
    );
  }
);

Select.displayName = 'Select';

interface SelectOptionProps extends React.OptionHTMLAttributes<HTMLOptionElement> {}

export const SelectOption = ({ children, ...props }: SelectOptionProps) => {
  return <option {...props}>{children}</option>;
};
