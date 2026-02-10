import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { useAuthStore } from '../stores/auth';

export function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const login = useAuthStore((s) => s.login);
  
  const from = (location.state as { from?: { pathname?: string } })?.from?.pathname || '/devices';
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    
    const success = await login(password);
    if (success) {
      navigate(from, { replace: true });
    } else {
      setError('密码错误');
    }
    
    setIsLoading(false);
  };
  
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold mb-2">tmex</h1>
          <p className="text-text-secondary">Web 终端管理平台</p>
        </div>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input w-full"
              placeholder="输入管理员密码"
              autoFocus
            />
          </div>
          
          {error && (
            <div className="text-danger text-sm">{error}</div>
          )}
          
          <button
            type="submit"
            disabled={isLoading || !password}
            className="btn btn-primary w-full justify-center disabled:opacity-50"
          >
            {isLoading ? '登录中...' : '登录'}
          </button>
        </form>
        
        <p className="mt-6 text-center text-sm text-text-muted">
          首次使用？请查看环境变量配置管理员密码
        </p>
      </div>
    </div>
  );
}
