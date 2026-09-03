import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Description,
  Transition,
} from "@headlessui/react";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, title, message, danger, confirmLabel, onConfirm, onCancel } = props;
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Transition appear show={open}>
      <Dialog as="div" className="zeta-dialog" onClose={onCancel} role="alertdialog">
        <DialogBackdrop className="zeta-backdrop" />
        <div className="zeta-dialog-center">
          <DialogPanel className="zeta-panel">
            <DialogTitle className="zeta-dialog-title">{title}</DialogTitle>
            <Description className="zeta-dialog-desc">{message}</Description>
            <div className="zeta-dialog-actions">
              <button ref={cancelRef} className="btn" onClick={onCancel} autoFocus>
                取消
              </button>
              <button className={danger ? "btn danger" : "btn primary"} onClick={onConfirm}>
                {confirmLabel ?? "确认"}
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </Transition>
  );
}

export type PromptDialogProps = {
  open: boolean;
  title: string;
  label: string;
  defaultValue?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
};

export function PromptDialog(props: PromptDialogProps) {
  const { open, title, label, defaultValue, onConfirm, onCancel } = props;
  const [value, setValue] = useState(defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue ?? "");
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, defaultValue]);

  const trimmed = value.trim();
  const submit = () => {
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <Transition appear show={open}>
      <Dialog as="div" className="zeta-dialog" onClose={onCancel}>
        <DialogBackdrop className="zeta-backdrop" />
        <div className="zeta-dialog-center">
          <DialogPanel className="zeta-panel">
            <DialogTitle className="zeta-dialog-title">{title}</DialogTitle>
            <label className="zeta-dialog-label" htmlFor="zeta-prompt-input">
              {label}
            </label>
            <input
              id="zeta-prompt-input"
              ref={inputRef}
              className="zeta-dialog-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className="zeta-dialog-actions">
              <button className="btn" onClick={onCancel}>
                取消
              </button>
              <button className="btn primary" onClick={submit} disabled={!trimmed}>
                确认
              </button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </Transition>
  );
}
