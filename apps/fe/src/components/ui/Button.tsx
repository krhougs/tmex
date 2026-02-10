import * as React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'default' | 'sm' | 'lg';
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'default', size = 'default', asChild, children, ...props }, ref) => {
    const baseStyles = 'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50';
    
    const variants = {
      default: 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-border)]',
      primary: 'bg-[var(--color-accent)] text-white border border-[var(--color-accent)] hover:bg-[var(--color-accent-hover)]',
      danger: 'bg-[var(--color-danger)] text-white border border-[var(--color-danger)] hover:opacity-90',
      ghost: 'hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text)]',
    };
    
    const sizes = {
      default: 'h-9 px-4 py-2 text-sm',
      sm: 'h-8 px-3 py-1 text-xs',
      lg: 'h-10 px-6 py-2 text-base',
    };

    if (asChild && React.isValidElement(children)) {
      const childElement = children as React.ReactElement<{ className?: string }>;
      return React.cloneElement(childElement, {
        ...props,
        className: `${baseStyles} ${variants[variant]} ${sizes[size]} ${className} ${childElement.props.className || ''}`,
        ref,
      } as React.Attributes);
    }

    return (
      <button
        ref={ref}
        className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
