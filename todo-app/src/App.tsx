import { useState, useRef, useEffect } from 'react'
import './App.css'

interface Todo {
  id: string
  text: string
  completed: boolean
  createdAt: number
}

type Filter = 'all' | 'active' | 'completed'

export default function App() {
  const [todos, setTodos] = useState<Todo[]>(() => {
    try {
      const saved = localStorage.getItem('todo-app-todos')
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  const [input, setInput] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    localStorage.setItem('todo-app-todos', JSON.stringify(todos))
  }, [todos])

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  const addTodo = () => {
    const text = input.trim()
    if (!text) return
    setTodos(prev => [{
      id: crypto.randomUUID(),
      text,
      completed: false,
      createdAt: Date.now(),
    }, ...prev])
    setInput('')
  }

  const toggleTodo = (id: string) => {
    setTodos(prev => prev.map(t =>
      t.id === id ? { ...t, completed: !t.completed } : t
    ))
  }

  const deleteTodo = (id: string) => {
    setTodos(prev => prev.filter(t => t.id !== id))
  }

  const startEdit = (todo: Todo) => {
    setEditingId(todo.id)
    setEditText(todo.text)
  }

  const saveEdit = () => {
    const text = editText.trim()
    if (text) {
      setTodos(prev => prev.map(t =>
        t.id === editingId ? { ...t, text } : t
      ))
    }
    setEditingId(null)
    setEditText('')
  }

  const clearCompleted = () => {
    setTodos(prev => prev.filter(t => !t.completed))
  }

  const filtered = todos.filter(t => {
    if (filter === 'active') return !t.completed
    if (filter === 'completed') return t.completed
    return true
  })

  const activeCount = todos.filter(t => !t.completed).length
  const completedCount = todos.filter(t => t.completed).length

  return (
    <div className="app">
      <div className="container">
        <header className="header">
          <h1>📝 Todo List</h1>
          <p className="subtitle">专注每一天，完成每一件小事</p>
        </header>

        {/* Input */}
        <div className="input-section">
          <input
            type="text"
            className="todo-input"
            placeholder="添加新任务…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addTodo()}
          />
          <button className="add-btn" onClick={addTodo} disabled={!input.trim()}>
            添加
          </button>
        </div>

        {/* Filters */}
        <div className="filters">
          {(['all', 'active', 'completed'] as Filter[]).map(f => (
            <button
              key={f}
              className={`filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' && `全部 (${todos.length})`}
              {f === 'active' && `待完成 (${activeCount})`}
              {f === 'completed' && `已完成 (${completedCount})`}
            </button>
          ))}
        </div>

        {/* Todo List */}
        <ul className="todo-list">
          {filtered.length === 0 ? (
            <li className="empty-state">
              {filter === 'all' && '还没有任务，添加一个吧 ✨'}
              {filter === 'active' && '所有任务都已完成 🎉'}
              {filter === 'completed' && '还没有已完成的任务'}
            </li>
          ) : (
            filtered.map(todo => (
              <li key={todo.id} className={`todo-item ${todo.completed ? 'completed' : ''} ${editingId === todo.id ? 'editing' : ''}`}>
                <label className="todo-label">
                  <input
                    type="checkbox"
                    className="todo-checkbox"
                    checked={todo.completed}
                    onChange={() => toggleTodo(todo.id)}
                  />
                  <span className="todo-text">
                    {editingId === todo.id ? (
                      <input
                        ref={editInputRef}
                        className="edit-input"
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        onBlur={saveEdit}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveEdit()
                          if (e.key === 'Escape') { setEditingId(null); setEditText(''); }
                        }}
                      />
                    ) : (
                      <span onDoubleClick={() => startEdit(todo)}>{todo.text}</span>
                    )}
                  </span>
                </label>
                <div className="todo-actions">
                  {editingId !== todo.id && (
                    <>
                      <button className="action-btn edit" onClick={() => startEdit(todo)} title="编辑">✏️</button>
                      <button className="action-btn delete" onClick={() => deleteTodo(todo.id)} title="删除">🗑️</button>
                    </>
                  )}
                </div>
              </li>
            ))
          )}
        </ul>

        {/* Footer */}
        {todos.length > 0 && (
          <div className="footer">
            <span className="stats">
              共 {todos.length} 项，{activeCount} 项待完成
            </span>
            {completedCount > 0 && (
              <button className="clear-btn" onClick={clearCompleted}>
                清除已完成 ({completedCount})
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
