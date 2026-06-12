import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Input({ label, className = '', ...props }: InputProps) {
  return (
    <div className="flex flex-col gap-2">
      {label && <label className="text-sm font-medium text-gray-300">{label}</label>}
      <input
        className={`bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white placeholder-gray-400 focus:outline-none focus:border-orange-500 transition-colors ${className}`}
        {...props}
      />
    </div>
  );
}
