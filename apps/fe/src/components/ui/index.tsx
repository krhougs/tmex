import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import * as React from 'react';

import { Alert, AlertDescription, AlertTitle } from './alert';
import { Button as BaseButton, buttonVariants } from './button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card';
import {
  Dialog as BaseDialog,
  DialogClose as BaseDialogClose,
  DialogContent as BaseDialogContent,
  DialogFooter as BaseDialogFooter,
  DialogHeader as BaseDialogHeader,
  DialogTitle as BaseDialogTitle,
  DialogDescription,
} from './dialog';
import { Input } from './input';
import {
  Select as BaseSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select';
import { Textarea } from './textarea';

export { Alert, AlertDescription, AlertTitle };
export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
export { Input, Textarea, DialogDescription };

export { Badge } from './badge';
export { Separator } from './separator';
export {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './sheet';
export { Switch } from './switch';
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

type LegacyVariant = 'default' | 'primary' | 'danger' | 'ghost';
type LegacySize = 'default' | 'sm' | 'lg';

interface ButtonProps extends Omit<React.ComponentProps<typeof BaseButton>, 'variant' | 'size'> {
  variant?: LegacyVariant;
  size?: LegacySize;
  asChild?: boolean;
}

function mapButtonVariant(variant: LegacyVariant): 'default' | 'outline' | 'destructive' | 'ghost' {
  if (variant === 'primary') {
    return 'default';
  }
  if (variant === 'danger') {
    return 'destructive';
  }
  if (variant === 'ghost') {
    return 'ghost';
  }
  return 'outline';
}

function mapButtonSize(size: LegacySize): 'default' | 'sm' | 'lg' {
  if (size === 'sm') {
    return 'sm';
  }
  if (size === 'lg') {
    return 'lg';
  }
  return 'default';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant = 'default', size = 'default', asChild = false, children, ...props },
    ref
  ) => {
    const mappedVariant = mapButtonVariant(variant);
    const mappedSize = mapButtonSize(size);

    if (asChild && React.isValidElement(children)) {
      const child = children as React.ReactElement<{ className?: string }>;
      return React.cloneElement(child, {
        ...props,
        className: cn(
          buttonVariants({ variant: mappedVariant, size: mappedSize }),
          className,
          child.props.className
        ),
      });
    }

    return (
      <BaseButton
        ref={ref}
        variant={mappedVariant}
        size={mappedSize}
        className={className}
        {...props}
      >
        {children}
      </BaseButton>
    );
  }
);

Button.displayName = 'Button';

interface DialogProps extends React.ComponentProps<typeof BaseDialog> {
  children: React.ReactNode;
}

export function Dialog({ children, ...props }: DialogProps) {
  return <BaseDialog {...props}>{children}</BaseDialog>;
}

interface DialogContentProps extends React.ComponentProps<typeof BaseDialogContent> {
  className?: string;
  children: React.ReactNode;
}

export function DialogContent({ className, children, ...props }: DialogContentProps) {
  return (
    <BaseDialogContent className={cn('sm:max-w-lg', className)} {...props}>
      {children}
    </BaseDialogContent>
  );
}

interface DialogHeaderProps extends React.ComponentProps<typeof BaseDialogHeader> {
  className?: string;
}

export function DialogHeader({ className, ...props }: DialogHeaderProps) {
  return <BaseDialogHeader className={cn('gap-1', className)} {...props} />;
}

interface DialogTitleProps extends React.ComponentProps<typeof BaseDialogTitle> {
  className?: string;
}

export function DialogTitle({ className, ...props }: DialogTitleProps) {
  return <BaseDialogTitle className={cn('text-lg', className)} {...props} />;
}

interface DialogCloseButtonProps {
  className?: string;
}

export function DialogCloseButton({ className }: DialogCloseButtonProps) {
  return (
    <BaseDialogClose
      render={
        <Button variant="ghost" size="sm" className={cn('absolute right-2 top-2', className)} />
      }
    >
      <X className="h-4 w-4" />
      <span className="sr-only">Close</span>
    </BaseDialogClose>
  );
}

interface DialogBodyProps extends React.ComponentProps<'div'> {
  className?: string;
}

export function DialogBody({ className, ...props }: DialogBodyProps) {
  return <div className={cn('space-y-4', className)} {...props} />;
}

interface DialogFooterProps extends React.ComponentProps<typeof BaseDialogFooter> {
  className?: string;
}

export function DialogFooter({ className, ...props }: DialogFooterProps) {
  return <BaseDialogFooter className={cn('pt-2', className)} {...props} />;
}

interface SelectProps
  extends Omit<
    React.SelectHTMLAttributes<HTMLSelectElement>,
    'onChange' | 'value' | 'defaultValue'
  > {
  value?: string;
  defaultValue?: string;
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void;
}

interface SelectOptionProps extends React.OptionHTMLAttributes<HTMLOptionElement> {
  children: React.ReactNode;
}

interface NormalizedOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
}

function normalizeOptions(children: React.ReactNode): NormalizedOption[] {
  const options: NormalizedOption[] = [];

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement<SelectOptionProps>(child)) {
      return;
    }

    if (child.props.value === undefined || child.props.value === null) {
      return;
    }

    options.push({
      value: String(child.props.value),
      label: child.props.children,
      disabled: child.props.disabled,
    });
  });

  return options;
}

export function Select({
  id,
  className,
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  required,
  name,
  ...rest
}: SelectProps) {
  const options = React.useMemo(() => normalizeOptions(children), [children]);
  const dataTestId = (rest as { 'data-testid'?: string })['data-testid'];

  const handleValueChange = (nextValue: string | null) => {
    if (!nextValue) {
      return;
    }

    if (!onChange) {
      return;
    }

    onChange({
      target: { value: nextValue, name } as EventTarget & HTMLSelectElement,
      currentTarget: { value: nextValue, name } as EventTarget & HTMLSelectElement,
    } as React.ChangeEvent<HTMLSelectElement>);
  };

  return (
    <BaseSelect
      value={value}
      defaultValue={defaultValue}
      onValueChange={handleValueChange}
      disabled={disabled}
      required={required}
      name={name}
    >
      <SelectTrigger id={id} data-testid={dataTestId} className={className}>
        <SelectValue placeholder={options[0]?.label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </BaseSelect>
  );
}

export function SelectOption(_props: SelectOptionProps) {
  return null;
}
