import React, { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/Card';
import { Button } from './ui/Button';
import { BarChart3, Zap, Shield, Brain } from 'lucide-react';

interface DashboardProps {
  jwtToken: string;
  salonId: string;
}

export function Dashboard({ jwtToken, salonId }: DashboardProps) {
  const [stats, setStats] = useState({
    apiStatus: 'online',
    rateLimit: '60/min',
    authStatus: 'jwt+rls',
    llmStatus: 'l0-l3',
  });

  const statCards = [
    { icon: Zap, label: 'API Status', value: stats.apiStatus, color: 'text-green-400' },
    { icon: Shield, label: 'Rate Limit', value: stats.rateLimit, color: 'text-blue-400' },
    { icon: Shield, label: 'Auth', value: stats.authStatus, color: 'text-purple-400' },
    { icon: Brain, label: 'LLM', value: stats.llmStatus, color: 'text-orange-400' },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {statCards.map((stat) => {
        const Icon = stat.icon;
        return (
          <Card key={stat.label}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-gray-400 text-sm">{stat.label}</p>
                <p className={`text-2xl font-bold mt-2 ${stat.color}`}>{stat.value}</p>
              </div>
              <Icon className={`w-8 h-8 ${stat.color} opacity-50`} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}
