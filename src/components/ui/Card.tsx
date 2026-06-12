import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
}

export function Card({ children, className = '' }: CardProps) {
  return (
    <div className={`bg-gray-800 border border-gray-700 rounded-lg p-6 hover:border-orange-500 transition-colors ${className}`}>
      {children}
    </div>
  );
}

export function CardHeader({ children }: CardProps) {
  return <div className="border-b border-gray-700 pb-4 mb-4">{children}</div>;
}

export function CardTitle({ children }: CardProps) {
  return <h2 className="text-xl font-bold text-white">{children}</h2>;
}

export function CardContent({ children }: CardProps) {
  return <div className="text-gray-300">{children}</div>;
}
