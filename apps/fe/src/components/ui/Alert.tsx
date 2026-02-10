import * as React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle, Info } from 'lucide-react';

interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'destructive' | 'warning' | 'success';
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className = '', variant = 'default', children, ...props }, ref) => {
    const variants = {
      default: 'bg-[var(--color-bg-tertiary)] border-[var(--color-border)] text-[var(--color-text)]',
      destructive: 'bg-red-950/30 border-red-900/50 text-red-400',
      warning: 'bg-yellow-950/30 border-yellow-900/50 text-yellow-400',
      success: 'bg-green-950/30 border-green-900/50 text-green-400',
    };

    const icons = {
      default: Info,
      destructive: AlertCircle,
      warning: AlertTriangle,
      success: CheckCircle,
    };

    const Icon = icons[variant];

    return (
      <div
        ref={ref}
        role="alert"
        className={`relative rounded-lg border p-4 ${variants[variant]} ${className}`}
        {...props}
      >
        <div className="flex gap-3">
          <Icon className="h-5 w-5 flex-shrink-0 mt-0.5" />
          <div className="flex-1">{children}</div>
        </div>
      </div>
    );
  }
);

Alert.displayName = 'Alert';

interface AlertTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {}

export const AlertTitle = React.forwardRef<HTMLHeadingElement, AlertTitleProps>(
  ({ className = '', ...props }, ref) => {
    return (
      <h5
        ref={ref}
        className={`font-medium mb-1 ${className}`}
        {...props}
      />
    );
  }
);

AlertTitle.displayName = 'AlertTitle';

interface AlertDescriptionProps extends React.HTMLAttributes<HTMLDivElement> {}

export const AlertDescription = React.forwardRef<HTMLDivElement, AlertDescriptionProps>(
  ({ className = '', ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`text-sm opacity-90 ${className}`}
        {...props}
      />
    );
  }
);

AlertDescription.displayName = 'AlertDescription';
