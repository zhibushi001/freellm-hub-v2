import { useState, useEffect } from 'react';
import { api, UsageLog, UsageDaily, PriceEntry } from '../api';
import { BarChart3, Download, TrendingUp, Activity, Cpu, Server, AlertTriangle, DollarSign, Trash2, Plus } from 'lucide-react';
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, PieChart, Pie, Cell,
} from 'recharts';

const COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#6366f1'];

export default function Usage() {
  const [logs, setLogs] = useState<UsageLog[]>([]);
  const [trend, setTrend] = useState<Array<{ day: string; total: number; successes: number; errors: number; total_tokens: number; avg_latency_ms: number }>>([]);
  const [modelStats, setModelStats] = useState<Array<{ model: string; requests: number; totalTokens: number; promptTokens: number; completionTokens: number; successes: number; failures: number; avgLatency: number }>>([]);
  const [channelStats, setChannelStats] = useState<Array<{ channelId: number; providerName: string; requests: number; totalTokens: number; successes: number; failures: number; avgLatency: number }>>([]);
  const [errorStats, setErrorStats] = useState<Array<{ errorCode: number | null; errorType: string; count: number; percentage: number }>>([]);
  const [overview, setOverview] = useState<{ totalRequests: number; successes: number; failures: number; successRate: number; totalTokens: number; promptTokens: number; completionTokens: number; avgLatency: number; minLatency: number; maxLatency: number; p50Latency?: number; p95Latency?: number; p99Latency?: number } | null>(null);
  const [slowRequests, setSlowRequests] = useState<Array<{ id: number; request_model: string; routed_model: string | null; provider_name: string | null; latency_ms: number; status: string; created_at: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState('7d');
  const [activeTab, setActiveTab] = useState<'overview' | 'models' | 'channels' | 'errors' | 'cost' | 'logs'>('overview');
  const [costGroup, setCostGroup] = useState<'provider' | 'model' | 'key' | 'hub_key' | 'day'>('provider');
  const [costRows, setCostRows] = useState<Array<{ bucket: string | number | null; requests: number; successes: number; prompt_tokens: number; completion_tokens: number; total_tokens: number; cost_usd: number }>>([]);
  const [costTotals, setCostTotals] = useState<{ requests: number; cost_usd: number; total_tokens: number; unpriced_requests: number } | null>(null);
  const [prices, setPrices] = useState<PriceEntry[]>([]);
  const [priceDraft, setPriceDraft] = useState({ provider_name: '', model_pattern: '', input_price_per_m: '', output_price_per_m: '', note: '' });
  const [priceMsg, setPriceMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    loadUsage();
  }, [dateRange]);

  useEffect(() => {
    if (activeTab !== 'cost') return;
    const days = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : 90;
    api.getCostStats(days, costGroup).then(r => { setCostRows(r.rows); setCostTotals(r.totals); }).catch(() => {});
    api.getPrices().then(r => setPrices(r.prices)).catch(() => {});
  }, [activeTab, costGroup, dateRange]);

  const savePrice = async () => {
    const d = priceDraft;
    if (!d.model_pattern.trim()) { setPriceMsg({ ok: false, text: '模型名/通配必填' }); return; }
    const pin = Number(d.input_price_per_m), pout = Number(d.output_price_per_m);
    if (!Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0) {
      setPriceMsg({ ok: false, text: '单价必须是非负数字 (美元/每百万 token)' }); return;
    }
    try {
      await api.savePrice({
        provider_name: d.provider_name.trim() || '*',
        model_pattern: d.model_pattern.trim(),
        input_price_per_m: pin, output_price_per_m: pout,
        note: d.note.trim() || null,
      });
      setPriceMsg({ ok: true, text: '已保存' });
      setPriceDraft({ provider_name: '', model_pattern: '', input_price_per_m: '', output_price_per_m: '', note: '' });
      api.getPrices().then(r => setPrices(r.prices)).catch(() => {});
    } catch (e: any) {
      setPriceMsg({ ok: false, text: e?.message || '保存失败' });
    }
  };

  const loadUsage = async () => {
    setLoading(true);
    try {
      const days = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : 90;
      const [logsData, trendData, overviewData, modelData, channelData, errorData, slowData] = await Promise.all([
        api.getUsageLogs(50).then(r => r.logs),
        api.getUsageTrend(days),
        api.getUsageOverview(days),
        api.getUsageModelStats(days),
        api.getUsageChannelStats(days),
        api.getUsageErrorStats(days),
        api.getSlowRequests(days, 10),
      ]);
      setLogs(logsData);
      setTrend(trendData.data || []);
      setOverview(overviewData.overview);
      setModelStats(modelData.stats);
      setChannelStats(channelData.stats);
      setErrorStats(errorData.stats);
      setSlowRequests(slowData.requests || []);
    } catch (err) {
      console.error('Failed to load usage:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = () => {
    const headers = ['时间', '渠道', '模型', 'Prompt Tokens', 'Completion Tokens', '延迟(ms)', '状态'];
    const rows = logs.map(log => [
      new Date(log.created_at).toLocaleString(),
      `渠道 #${log.channel_id || '-'}`,
      log.request_model,
      log.prompt_tokens,
      log.completion_tokens,
      log.latency_ms,
      log.status === 'success' ? '成功' : '失败',
    ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `usage-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
      </div>
    );
  }

  const days = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : 90;
  
  // Model stats for chart
  const modelChartData = modelStats.slice(0, 10).map(m => ({
    name: m.model.length > 15 ? m.model.slice(0, 15) + '...' : m.model,
    fullModel: m.model,
    requests: m.requests,
    tokens: m.totalTokens,
  }));
  
  // Error stats for pie chart
  const errorChartData = errorStats.map(e => ({
    name: e.errorType === 'unknown' ? '其他' : e.errorType,
    value: e.count,
    code: e.errorCode,
  }));

  return (
    <div className="space-y-4 md:space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white tracking-tight">用量统计</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-2">查看 API 使用情况和趋势分析</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white input-focus outline-none"
          >
            <option value="7d">最近 7 天</option>
            <option value="30d">最近 30 天</option>
            <option value="90d">最近 90 天</option>
          </select>
          <button onClick={handleExport} className="btn-secondary flex items-center gap-2">
            <Download size={16} />
            导出
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 sm:gap-2 border-b border-slate-200 dark:border-slate-700 overflow-x-auto -mx-1 px-1">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-3 sm:px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
            activeTab === 'overview'
              ? 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 border-b-transparent text-indigo-600 dark:text-indigo-400'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          <Activity size={16} />
          概览
        </button>
        <button
          onClick={() => setActiveTab('models')}
          className={`px-3 sm:px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
            activeTab === 'models'
              ? 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 border-b-transparent text-indigo-600 dark:text-indigo-400'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          <Cpu size={16} />
          模型统计
        </button>
        <button
          onClick={() => setActiveTab('channels')}
          className={`px-3 sm:px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
            activeTab === 'channels'
              ? 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 border-b-transparent text-indigo-600 dark:text-indigo-400'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          <Server size={16} />
          渠道统计
        </button>
        <button
          onClick={() => setActiveTab('cost')}
          className={`px-4 py-2.5 text-sm font-medium transition-colors ${
            activeTab === 'cost'
              ? 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 border-b-transparent text-indigo-600 dark:text-indigo-400'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          <span className="flex items-center gap-1.5"><DollarSign className="w-4 h-4" />成本</span>
        </button>
        <button
          onClick={() => setActiveTab('errors')}
          className={`px-3 sm:px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
            activeTab === 'errors'
              ? 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 border-b-transparent text-indigo-600 dark:text-indigo-400'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          <AlertTriangle size={16} />
          错误分析
        </button>
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-5">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2.5 rounded-xl bg-blue-50 dark:bg-blue-500/10 shrink-0">
                  <Activity size={18} className="text-blue-600 dark:text-blue-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-slate-500 dark:text-slate-400">总请求数</p>
                  <p className="text-2xl font-bold text-slate-900 dark:text-white truncate" title={String(overview?.totalRequests ?? 0)}>{overview?.totalRequests.toLocaleString() || 0}</p>
                </div>
              </div>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-5">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 shrink-0">
                  <TrendingUp size={18} className="text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-slate-500 dark:text-slate-400">成功率</p>
                  <p className="text-2xl font-bold text-slate-900 dark:text-white truncate">{overview?.successRate || 0}%</p>
                </div>
              </div>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-5">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2.5 rounded-xl bg-violet-50 dark:bg-violet-500/10 shrink-0">
                  <BarChart3 size={18} className="text-violet-600 dark:text-violet-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-slate-500 dark:text-slate-400">总 Tokens</p>
                  <p className="text-2xl font-bold text-slate-900 dark:text-white truncate" title={String(overview?.totalTokens ?? 0)}>{overview?.totalTokens.toLocaleString() || 0}</p>
                </div>
              </div>
            </div>
            {/* P3-4: 延迟分位 (P50/P95/P99) */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-5">
              <div className="flex items-start justify-between gap-3 min-w-0">
                <div className="p-2.5 rounded-xl bg-orange-50 dark:bg-orange-500/10 shrink-0">
                  <BarChart3 size={18} className="text-orange-600 dark:text-orange-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-500 dark:text-slate-400">延迟分位</p>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-xs text-slate-400">P50</span>
                    <span className="text-lg font-semibold text-slate-900 dark:text-white">{overview?.p50Latency || 0}</span>
                    <span className="text-xs text-slate-400 ml-2">P95</span>
                    <span className="text-lg font-semibold text-amber-600 dark:text-amber-400">{overview?.p95Latency || 0}</span>
                    <span className="text-xs text-slate-400 ml-2">P99</span>
                    <span className="text-lg font-semibold text-red-600 dark:text-red-400">{overview?.p99Latency || 0}</span>
                    <span className="text-xs text-slate-400 ml-1">ms</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* P3-4: 慢请求 Top 10 */}
          {slowRequests.length > 0 && (
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 overflow-hidden">
              <div className="p-4 sm:p-6 border-b border-slate-200/50 dark:border-slate-700/50 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">慢请求 Top 10</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">按延迟降序, 帮助定位拖慢网关的上游</p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-700/30">
                    <tr className="border-b border-slate-200/50 dark:border-slate-700/50">
                      <th className="text-left px-3 sm:px-6 py-2.5 font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap">延迟 (ms)</th>
                      <th className="text-left px-3 sm:px-6 py-2.5 font-medium text-slate-500 dark:text-slate-400">请求模型</th>
                      <th className="text-left px-3 sm:px-6 py-2.5 font-medium text-slate-500 dark:text-slate-400 hidden sm:table-cell">上游</th>
                      <th className="text-center px-3 sm:px-6 py-2.5 font-medium text-slate-500 dark:text-slate-400">状态</th>
                      <th className="text-left px-3 sm:px-6 py-2.5 font-medium text-slate-500 dark:text-slate-400 hidden md:table-cell">时间</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                    {slowRequests.map((r) => (
                      <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/20">
                        <td className="px-3 sm:px-6 py-3 font-mono text-amber-600 dark:text-amber-400 whitespace-nowrap">
                          {r.latency_ms.toLocaleString()}
                        </td>
                        <td className="px-3 sm:px-6 py-3">
                          <code className="text-xs text-slate-900 dark:text-white truncate block max-w-[160px]" title={r.request_model}>{r.request_model}</code>
                          {r.routed_model && r.routed_model !== r.request_model && (
                            <div className="text-[10px] text-slate-400 mt-0.5 truncate max-w-[160px]">→ {r.routed_model}</div>
                          )}
                        </td>
                        <td className="px-3 sm:px-6 py-3 text-xs text-slate-500 dark:text-slate-400 hidden sm:table-cell">
                          {r.provider_name || '-'}
                        </td>
                        <td className="px-3 sm:px-6 py-3 text-center">
                          <span className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap ${r.status === 'success' ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400' : 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'}`}>
                            {r.status === 'success' ? '成功' : '失败'}
                          </span>
                        </td>
                        <td className="px-3 sm:px-6 py-3 text-xs text-slate-500 dark:text-slate-400 hidden md:table-cell whitespace-nowrap">
                          {new Date(r.created_at).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-4 sm:p-6">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4 sm:mb-5">请求趋势</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ top: 5, right: 10, bottom: 5, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
                    <XAxis dataKey="day" className="text-xs text-slate-500 dark:text-slate-400" tick={{ fontSize: 10 }} />
                    <YAxis className="text-xs text-slate-500 dark:text-slate-400" tick={{ fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0' }}
                      formatter={(value: number, name: string) => [value.toLocaleString(), name === 'total' ? '请求数' : name === 'successes' ? '成功' : '失败']}
                    />
                    <Legend formatter={(value) => value === 'total' ? '请求数' : value === 'successes' ? '成功' : '失败'} />
                    <Line type="monotone" dataKey="total" stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="successes" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="errors" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-4 sm:p-6">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4 sm:mb-5">Token 用量趋势</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trend} margin={{ top: 5, right: 10, bottom: 5, left: -20 }}>
                    <defs>
                      <linearGradient id="colorTokens" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
                    <XAxis dataKey="day" className="text-xs text-slate-500 dark:text-slate-400" tick={{ fontSize: 10 }} />
                    <YAxis className="text-xs text-slate-500 dark:text-slate-400" tick={{ fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0' }}
                      formatter={(value: number) => [value.toLocaleString(), 'Tokens']}
                    />
                    <Area type="monotone" dataKey="total_tokens" stroke="#8b5cf6" strokeWidth={2} fillOpacity={1} fill="url(#colorTokens)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Models Tab */}
      {activeTab === 'models' && (
        <div className="space-y-4 md:space-y-6">
          {modelStats.length > 0 && (
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-4 sm:p-6">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4 sm:mb-5">Top 10 模型请求量</h3>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={modelChartData} margin={{ top: 5, right: 10, bottom: 5, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
                    <XAxis dataKey="name" className="text-xs text-slate-500 dark:text-slate-400" tick={{ fontSize: 10 }} />
                    <YAxis className="text-xs text-slate-500 dark:text-slate-400" tick={{ fontSize: 10 }} />
                    <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0' }} />
                    <Legend formatter={(value) => value === 'requests' ? '请求数' : 'Tokens'} />
                    <Line type="monotone" dataKey="requests" stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} />
                    <Line type="monotone" dataKey="tokens" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 overflow-hidden">
            <div className="p-4 sm:p-6 border-b border-slate-200/50 dark:border-slate-700/50">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">模型详细统计</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 dark:bg-slate-700/30">
                  <tr>
                    <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">模型</th>
                    <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">请求数</th>
                    <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Total Tokens</th>
                    <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">成功率</th>
                    <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">平均延迟</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                  {modelStats.map((stat, idx) => (
                    <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                      <td className="px-3 sm:px-6 py-4">
                        <span className="px-2.5 py-1 text-xs font-medium rounded-full whitespace-nowrap bg-indigo-100 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300">
                          {stat.model}
                        </span>
                      </td>
                      <td className="px-3 sm:px-6 py-4 text-sm text-slate-600 dark:text-slate-400">{stat.requests.toLocaleString()}</td>
                      <td className="px-3 sm:px-6 py-4 text-sm text-slate-600 dark:text-slate-400">{stat.totalTokens.toLocaleString()}</td>
                      <td className="px-3 sm:px-6 py-4">
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                          stat.successes / stat.requests > 0.99
                            ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
                            : stat.successes / stat.requests > 0.95
                            ? 'bg-yellow-100 text-yellow-600 dark:bg-yellow-500/10 dark:text-yellow-400'
                            : 'bg-red-100 text-red-600 dark:bg-red-500/10 dark:text-red-400'
                        }`}>
                          {stat.requests > 0 ? Math.round((stat.successes / stat.requests) * 100) : 0}%
                        </span>
                      </td>
                      <td className="px-3 sm:px-6 py-4 text-sm text-slate-600 dark:text-slate-400">{stat.avgLatency}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Channels Tab */}
      {activeTab === 'channels' && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 overflow-hidden">
          <div className="p-4 sm:p-6 border-b border-slate-200/50 dark:border-slate-700/50">
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">渠道统计</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 dark:bg-slate-700/30">
                <tr>
                  <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">渠道 ID</th>
                  <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">提供商</th>
                  <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">请求数</th>
                  <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Total Tokens</th>
                  <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">成功率</th>
                  <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">平均延迟</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                {channelStats.map((stat) => (
                  <tr key={stat.channelId} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                    <td className="px-3 sm:px-6 py-4 text-sm font-medium text-slate-900 dark:text-white">#{stat.channelId}</td>
                    <td className="px-3 sm:px-6 py-4">
                      <span className="px-2.5 py-1 text-xs font-medium rounded-full whitespace-nowrap bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                        {stat.providerName}
                      </span>
                    </td>
                    <td className="px-3 sm:px-6 py-4 text-sm text-slate-600 dark:text-slate-400">{stat.requests.toLocaleString()}</td>
                    <td className="px-3 sm:px-6 py-4 text-sm text-slate-600 dark:text-slate-400">{stat.totalTokens.toLocaleString()}</td>
                    <td className="px-3 sm:px-6 py-4">
                      <span className="px-2 py-1 text-xs font-medium rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
                        {stat.requests > 0 ? Math.round((stat.successes / stat.requests) * 100) : 0}%
                      </span>
                    </td>
                    <td className="px-3 sm:px-6 py-4 text-sm text-slate-600 dark:text-slate-400">{stat.avgLatency}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Errors Tab */}
      {activeTab === 'cost' && (
        <div className="space-y-4 md:space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-4 sm:p-6">
              <div className="text-xs text-slate-500 dark:text-slate-400">区间总花费</div>
              <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">
                ${(costTotals?.cost_usd ?? 0).toFixed(4)}
              </div>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-4 sm:p-6">
              <div className="text-xs text-slate-500 dark:text-slate-400">请求数 / Token</div>
              <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">
                {costTotals?.requests ?? 0}
                <span className="ml-2 text-sm font-normal text-slate-500">{(costTotals?.total_tokens ?? 0).toLocaleString()} tok</span>
              </div>
            </div>
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-4 sm:p-6">
              <div className="text-xs text-slate-500 dark:text-slate-400">未配价格的请求</div>
              <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-white">
                {costTotals?.unpriced_requests ?? 0}
              </div>
              <div className="text-xs text-slate-400 mt-1">免费渠道正常; 付费渠道请在下方价格表登记</div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-slate-200/50 dark:border-slate-700/50 flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-slate-900 dark:text-white">花费明细</h3>
              <div className="ml-auto flex gap-1">
                {(['provider', 'model', 'key', 'hub_key', 'day'] as const).map(g => (
                  <button key={g} onClick={() => setCostGroup(g)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                      costGroup === g ? 'bg-indigo-500 text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                    }`}>
                    {{ provider: '按渠道', model: '按模型', key: '按上游 Key', hub_key: '按 Hub Key', day: '按天' }[g]}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50">
                  <tr>
                    <th className="px-4 sm:px-6 py-3 text-left font-medium text-slate-500 dark:text-slate-400">分组</th>
                    <th className="px-4 py-3 text-right font-medium text-slate-500 dark:text-slate-400">请求</th>
                    <th className="px-4 py-3 text-right font-medium text-slate-500 dark:text-slate-400">Token</th>
                    <th className="px-4 sm:px-6 py-3 text-right font-medium text-slate-500 dark:text-slate-400">花费 (USD)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                  {costRows.length === 0 ? (
                    <tr><td colSpan={4} className="px-4 sm:px-6 py-8 text-center text-slate-400 text-sm">该区间还没有用量记录</td></tr>
                  ) : costRows.map((r, i) => (
                    <tr key={i}>
                      <td className="px-4 sm:px-6 py-3 text-slate-900 dark:text-white font-medium">{String(r.bucket ?? '—')}</td>
                      <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-300">{r.requests}</td>
                      <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-300">{r.total_tokens.toLocaleString()}</td>
                      <td className="px-4 sm:px-6 py-3 text-right font-semibold text-slate-900 dark:text-white">${r.cost_usd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 overflow-hidden">
            <div className="px-4 sm:px-6 py-4 border-b border-slate-200/50 dark:border-slate-700/50">
              <h3 className="font-semibold text-slate-900 dark:text-white">价格表 (美元 / 每百万 token)</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                渠道名留空 = 全局默认价; 模型名支持前缀通配 (如 <code>gpt-4o*</code>)。匹配优先级: 渠道+精确 &gt; 渠道+通配 &gt; 全局+精确 &gt; 全局+通配。
              </p>
            </div>
            <div className="p-4 sm:p-6 grid grid-cols-1 md:grid-cols-5 gap-3">
              <input value={priceDraft.provider_name} onChange={e => setPriceDraft({ ...priceDraft, provider_name: e.target.value })}
                placeholder="渠道 (留空=全局)" className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm" />
              <input value={priceDraft.model_pattern} onChange={e => setPriceDraft({ ...priceDraft, model_pattern: e.target.value })}
                placeholder="模型 / 通配 (必填)" className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm" />
              <input value={priceDraft.input_price_per_m} onChange={e => setPriceDraft({ ...priceDraft, input_price_per_m: e.target.value })}
                placeholder="输入单价" inputMode="decimal" className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm" />
              <input value={priceDraft.output_price_per_m} onChange={e => setPriceDraft({ ...priceDraft, output_price_per_m: e.target.value })}
                placeholder="输出单价" inputMode="decimal" className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm" />
              <button onClick={savePrice}
                className="px-3 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium flex items-center justify-center gap-1">
                <Plus className="w-4 h-4" />保存
              </button>
            </div>
            {priceMsg && (
              <div className={`px-4 sm:px-6 pb-3 text-xs ${priceMsg.ok ? 'text-green-600' : 'text-red-500'}`}>{priceMsg.text}</div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50">
                  <tr>
                    <th className="px-4 sm:px-6 py-3 text-left font-medium text-slate-500 dark:text-slate-400">渠道</th>
                    <th className="px-4 py-3 text-left font-medium text-slate-500 dark:text-slate-400">模型 / 通配</th>
                    <th className="px-4 py-3 text-right font-medium text-slate-500 dark:text-slate-400">输入</th>
                    <th className="px-4 py-3 text-right font-medium text-slate-500 dark:text-slate-400">输出</th>
                    <th className="px-4 sm:px-6 py-3 text-right font-medium text-slate-500 dark:text-slate-400"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                  {prices.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 sm:px-6 py-8 text-center text-slate-400 text-sm">还没有登记价格 —— 成本看板会全部显示 $0</td></tr>
                  ) : prices.map(p => (
                    <tr key={p.id}>
                      <td className="px-4 sm:px-6 py-3 text-slate-900 dark:text-white">{p.provider_name === '*' ? '(全局)' : p.provider_name}</td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-700 dark:text-slate-300">{p.model_pattern}</td>
                      <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-300">${p.input_price_per_m}</td>
                      <td className="px-4 py-3 text-right text-slate-600 dark:text-slate-300">${p.output_price_per_m}</td>
                      <td className="px-4 sm:px-6 py-3 text-right">
                        <button onClick={() => api.deletePrice(p.id).then(() => api.getPrices().then(r => setPrices(r.prices))).catch(() => {})}
                          className="text-red-500 hover:text-red-400" title="删除"><Trash2 className="w-4 h-4 inline" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'errors' && (
        <div className="space-y-4 md:space-y-6">
          {errorStats.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-4 sm:p-6">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4 sm:mb-5">错误分布</h3>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={errorChartData}
                        cx="50%"
                        cy="50%"
                        labelLine={false}
                        label={({ name, value }) => `${name}: ${value}`}
                        outerRadius={80}
                        fill="#8884d8"
                        dataKey="value"
                      >
                        {errorChartData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0' }} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 p-4 sm:p-6">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-4 sm:mb-5">错误详情</h3>
                <div className="space-y-3">
                  {errorStats.map((err, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-700/30 rounded-lg">
                      <div className="flex items-center gap-3">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[idx % COLORS.length] }} />
                        <div>
                          <p className="text-sm font-medium text-slate-900 dark:text-white">
                            {err.errorCode ? `HTTP ${err.errorCode}` : err.errorType}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">{err.errorType}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-slate-900 dark:text-white">{err.count}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">{err.percentage}%</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200/50 dark:border-slate-700/50 overflow-hidden">
            <div className="p-4 sm:p-6 border-b border-slate-200/50 dark:border-slate-700/50">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">最近失败请求</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 dark:bg-slate-700/30">
                  <tr>
                    <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">时间</th>
                    <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">模型</th>
                    <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">错误码</th>
                    <th className="text-left px-3 sm:px-6 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">错误类型</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
                  {logs.filter(l => l.status === 'error').slice(0, 10).map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors">
                      <td className="px-3 sm:px-6 py-4 text-sm text-slate-600 dark:text-slate-400">
                        {new Date(log.created_at).toLocaleString()}
                      </td>
                      <td className="px-3 sm:px-6 py-4">
                        <span className="px-2.5 py-1 text-xs font-medium rounded-full whitespace-nowrap bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
                          {log.request_model}
                        </span>
                      </td>
                      <td className="px-3 sm:px-6 py-4 text-sm text-red-600 dark:text-red-400">
                        {log.error_code ? `HTTP ${log.error_code}` : '-'}
                      </td>
                      <td className="px-3 sm:px-6 py-4 text-sm text-slate-600 dark:text-slate-400">
                        <span title={log.error_message || ''}>
                          {log.error_type || '未知'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
