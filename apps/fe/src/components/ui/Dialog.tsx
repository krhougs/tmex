import * as React from 'react';
import { Dialog } from '@base-ui-components/react/dialog';
import { X } from 'lucide-react';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export const DialogRoot = ({ open, onOpenChange, children }: DialogProps) => {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </Dialog.Root>
  );
};

interface DialogContentProps {
  children: React.ReactNode;
  className?: string;
}

export const DialogContent = ({ children, className = '' }: DialogContentProps) => {
  return (
    <Dialog.Portal>
      <Dialog.Backdrop
        className="fixed inset-0 bg-black/50 z-50"
      />
      <Dialog.Popup
        className={`fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%] bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg max-h-[90vh] overflow-auto ${className}`}
      >
        {children}
      </Dialog.Popup>
    </Dialog.Portal>
  );
};

interface DialogHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export const DialogHeader = ({ children, className = '' }: DialogHeaderProps) => {
  return (
    <div className={`flex items-center justify-between p-4 border-b border-[var(--color-border)] ${className}`}>
      {children}
    </div>
  );
};

interface DialogTitleProps {
  children: React.ReactNode;
  className?: string;
}

export const DialogTitle = ({ children, className = '' }: DialogTitleProps) => {
  return (
    <Dialog.Title className={`text-lg font-semibold ${className}`}>
      {children}
    </Dialog.Title>
  );
};

interface DialogCloseButtonProps {
  className?: string;
}

export const DialogCloseButton = ({ className = '' }: DialogCloseButtonProps) => {
  return (
    <Dialog.Close
      className={`p-1 rounded-md text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors ${className}`}
    >
      <X className="h-4 w-4" />
    </Dialog.Close>
  );
};

interface DialogBodyProps {
  children: React.ReactNode;
  className?: string;
}

export const DialogBody = ({ children, className = '' }: DialogBodyProps) => {
  return (
    <div className={`p-4 ${className}`}>
      {children}
    </div>
  );
};

interface DialogFooterProps {
  children: React.ReactNode;
  className?: string;
}

export const DialogFooter = ({ children, className = '' }: DialogFooterProps) => {
  return (
    <div className={`flex gap-3 pt-4 ${className}`}>
      {children}
    </div>
  );
};

// Re-export for convenience
export { DialogRoot as Dialog };
