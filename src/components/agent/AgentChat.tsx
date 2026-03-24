import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare, Send, X, Bot, User, CheckCircle, XCircle,
  Loader2, Sparkles, ChevronDown, AlertTriangle
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

// ==================== Types ====================

interface PendingAction {
  tool_use_id: string;
  tool_name: string;
  input: Record<string, any>;
  description: string;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  pending_actions?: PendingAction[];
  action_results?: { tool_name: string; success: boolean; message: string }[];
}

interface AgentChatProps {
  isOpen: boolean;
  onClose: () => void;
}

// ==================== Quick Prompts ====================

const QUICK_PROMPTS = [
  { icon: '📊', label: 'Sales this week', prompt: 'How are sales looking this week? Any trends I should know about?' },
  { icon: '📦', label: 'Inventory check', prompt: 'What inventory items are running low? What should I order?' },
  { icon: '🍽️', label: 'Menu analysis', prompt: 'Which menu items are performing well and which should I consider removing or repricing?' },
  { icon: '📋', label: 'Prep for tomorrow', prompt: 'What should my team prep for tomorrow based on our sales patterns?' },
  { icon: '🚚', label: 'Delivery ROI', prompt: 'How are my delivery platforms performing? Which ones are actually profitable after commissions?' },
  { icon: '🗑️', label: 'Waste report', prompt: 'What\'s our waste situation? Where are we losing the most money?' },
];

// ==================== Component ====================

export default function AgentChat({ isOpen, onClose }: AgentChatProps) {
  const { currentEmployee } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [conversationHistory, setConversationHistory] = useState<any[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [isOpen]);

  // ==================== API Calls ====================

  const sendMessage = useCallback(async (text: string, approvedActions?: PendingAction[]) => {
    if (!text.trim() && !approvedActions) return;

    // Add user message to UI
    if (text.trim()) {
      setMessages(prev => [...prev, { role: 'user', text }]);
    }

    setIsLoading(true);
    setInput('');

    try {
      // Build conversation for Claude
      const newHistory = [...conversationHistory];
      if (text.trim()) {
        newHistory.push({ role: 'user', content: text });
      }

      const response = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${(currentEmployee as any)?.token}`,
        },
        body: JSON.stringify({
          messages: newHistory,
          approved_actions: approvedActions,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Agent request failed');
      }

      const data = await response.json();

      // Add assistant message
      if (data.messages?.[0]) {
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          text: data.messages[0].text,
          pending_actions: data.pending_actions,
        };
        setMessages(prev => [...prev, assistantMsg]);

        // Update conversation history
        newHistory.push({ role: 'assistant', content: data.messages[0].text });
        setConversationHistory(newHistory);
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'system',
        text: `Error: ${err.message}`,
      }]);
    } finally {
      setIsLoading(false);
    }
  }, [conversationHistory, currentEmployee]);

  // ==================== Action Approval ====================

  const handleApproveAction = useCallback(async (action: PendingAction) => {
    setIsLoading(true);

    try {
      const response = await fetch('/api/agent/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${(currentEmployee as any)?.token}`,
        },
        body: JSON.stringify({
          tool_name: action.tool_name,
          tool_use_id: action.tool_use_id,
          input: action.input,
        }),
      });

      const data = await response.json();

      // Add result to messages
      setMessages(prev => {
        const updated = [...prev];
        // Find the message with this pending action and mark it done
        const lastAssistant = [...updated].reverse().find(m => m.pending_actions?.some(a => a.tool_use_id === action.tool_use_id));
        if (lastAssistant) {
          lastAssistant.pending_actions = lastAssistant.pending_actions?.filter(a => a.tool_use_id !== action.tool_use_id);
          lastAssistant.action_results = [
            ...(lastAssistant.action_results || []),
            {
              tool_name: action.tool_name,
              success: data.success,
              message: data.success ? `✓ ${action.description}` : `✗ ${data.error || 'Failed'}`,
            },
          ];
        }
        return [...updated];
      });
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'system',
        text: `Failed to execute: ${err.message}`,
      }]);
    } finally {
      setIsLoading(false);
    }
  }, [currentEmployee]);

  const handleRejectAction = useCallback((action: PendingAction) => {
    setMessages(prev => {
      const updated = [...prev];
      const lastAssistant = [...updated].reverse().find(m => m.pending_actions?.some(a => a.tool_use_id === action.tool_use_id));
      if (lastAssistant) {
        lastAssistant.pending_actions = lastAssistant.pending_actions?.filter(a => a.tool_use_id !== action.tool_use_id);
        lastAssistant.action_results = [
          ...(lastAssistant.action_results || []),
          { tool_name: action.tool_name, success: false, message: `Skipped: ${action.description}` },
        ];
      }
      return [...updated];
    });
  }, []);

  // ==================== Render ====================

  if (!isOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[440px] bg-neutral-900 border-l border-neutral-700 shadow-2xl z-50 flex flex-col">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-neutral-100">POS Co-Pilot</h3>
            <p className="text-xs text-neutral-400">AI-powered restaurant assistant</p>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-neutral-700 text-neutral-400 hover:text-neutral-200 transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">

        {/* Empty state with quick prompts */}
        {messages.length === 0 && (
          <div className="space-y-4 mt-4">
            <div className="text-center">
              <Bot className="w-12 h-12 mx-auto text-brand-500 mb-3" />
              <h4 className="text-lg font-medium text-neutral-200">What can I help with?</h4>
              <p className="text-sm text-neutral-400 mt-1">I can analyze your data and take action on your behalf.</p>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-6">
              {QUICK_PROMPTS.map((qp, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(qp.prompt)}
                  className="text-left p-3 rounded-lg bg-neutral-800 hover:bg-neutral-750 border border-neutral-700 hover:border-brand-600 transition-all group"
                >
                  <span className="text-lg">{qp.icon}</span>
                  <p className="text-xs text-neutral-300 mt-1 group-hover:text-neutral-100">{qp.label}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message thread */}
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-2.5 ${msg.role === 'user' ? 'justify-end' : ''}`}>
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-full bg-brand-600 flex-shrink-0 flex items-center justify-center mt-0.5">
                <Bot className="w-3.5 h-3.5 text-white" />
              </div>
            )}

            <div className={`max-w-[85%] ${
              msg.role === 'user'
                ? 'bg-brand-600 text-white rounded-2xl rounded-tr-md px-4 py-2.5'
                : msg.role === 'system'
                ? 'bg-red-900/40 border border-red-800 rounded-xl px-4 py-2.5'
                : 'bg-neutral-800 text-neutral-100 rounded-2xl rounded-tl-md px-4 py-3'
            }`}>

              {/* Message text (with markdown-like rendering) */}
              <div className="text-sm whitespace-pre-wrap leading-relaxed">
                {msg.text.split('\n').map((line, li) => {
                  // Bold text
                  const rendered = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                  return <p key={li} className={li > 0 ? 'mt-1.5' : ''} dangerouslySetInnerHTML={{ __html: rendered }} />;
                })}
              </div>

              {/* Pending actions (approval buttons) */}
              {msg.pending_actions && msg.pending_actions.length > 0 && (
                <div className="mt-3 space-y-2 border-t border-neutral-700 pt-3">
                  <p className="text-xs font-medium text-neutral-400 uppercase tracking-wide">Proposed Actions</p>
                  {msg.pending_actions.map((action) => (
                    <div key={action.tool_use_id} className="bg-neutral-900 rounded-lg p-3 border border-neutral-700">
                      <p className="text-sm text-neutral-200 mb-2">{action.description}</p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handleApproveAction(action)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-50"
                        >
                          <CheckCircle className="w-3.5 h-3.5" /> Approve
                        </button>
                        <button
                          onClick={() => handleRejectAction(action)}
                          disabled={isLoading}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-neutral-700 hover:bg-neutral-600 text-neutral-300 transition-colors disabled:opacity-50"
                        >
                          <XCircle className="w-3.5 h-3.5" /> Skip
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Action results */}
              {msg.action_results && msg.action_results.length > 0 && (
                <div className="mt-2 space-y-1">
                  {msg.action_results.map((result, ri) => (
                    <div key={ri} className={`text-xs px-2 py-1 rounded ${result.success ? 'text-green-400 bg-green-900/20' : 'text-neutral-500 bg-neutral-800/50'}`}>
                      {result.message}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {msg.role === 'user' && (
              <div className="w-7 h-7 rounded-full bg-neutral-600 flex-shrink-0 flex items-center justify-center mt-0.5">
                <User className="w-3.5 h-3.5 text-white" />
              </div>
            )}
          </div>
        ))}

        {/* Loading indicator */}
        {isLoading && (
          <div className="flex gap-2.5">
            <div className="w-7 h-7 rounded-full bg-brand-600 flex-shrink-0 flex items-center justify-center">
              <Bot className="w-3.5 h-3.5 text-white" />
            </div>
            <div className="bg-neutral-800 rounded-2xl rounded-tl-md px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-neutral-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                Analyzing your data...
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-neutral-700 p-3 bg-neutral-800">
        <form
          onSubmit={(e) => { e.preventDefault(); sendMessage(input); }}
          className="flex gap-2"
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about your restaurant..."
            disabled={isLoading}
            className="flex-1 bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-2.5 text-sm text-neutral-100 placeholder-neutral-500 focus:outline-none focus:border-brand-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="p-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-30"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
        <p className="text-[10px] text-neutral-600 mt-1.5 text-center">AI may make mistakes. Always verify important decisions.</p>
      </div>
    </div>
  );
}
