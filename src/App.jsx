/**
 * 会議体ダッシュボード (日本語表示・変更履歴対応版)
 * * [主な仕様]
 * 1. UIの完全日本語化: すべてのラベル、ボタン、メッセージを日本語に翻訳
 * 2. 変更の可視化: 更新があった場合、「前回の日付 → 最新の日付」を表示
 * 3. 履歴管理: 編集時やインポート時に前回の日付を保持
 * 4. リアルタイム監視: Firestoreの状態を即座に画面に反映
 */

import React, { useState, useEffect, useRef } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  signInWithCustomToken, 
  onAuthStateChanged 
} from 'firebase/auth';
import { 
  getFirestore, collection, onSnapshot, query, 
  doc, deleteDoc, updateDoc, setDoc, serverTimestamp, getDocs
} from 'firebase/firestore';
import { 
  Search, CheckCircle, Clock, AlertTriangle, ExternalLink, 
  RefreshCw, Trash2, Edit3, X, Save, AlertCircle, Filter, Plus, FileUp, Database, ArrowRight
} from 'lucide-react';

// --- Firebase 設定 ---
const firebaseConfig = typeof __firebase_config !== 'undefined' 
  ? JSON.parse(__firebase_config) 
  : {
      apiKey: "AIzaSyBx5e752GWfvJDZ3lEx0IcArxjvCEz7S2M",
      authDomain: "seisakuresearch00.firebaseapp.com",
      projectId: "seisakuresearch00",
      storageBucket: "seisakuresearch00.firebasestorage.app",
      messagingSenderId: "356788263577",
      appId: "1:356788263577:web:ecc3782d0c82cb7da43608",
      measurementId: "G-Y1C3GPNC9Z"
    };

const appId = typeof __app_id !== 'undefined' ? __app_id : 'strategy-checker';

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);
const db = getFirestore(app);

// --- ヘルパー関数: 日本語の日付をタイムスタンプに変換 ---
const parseJapaneseDateToTs = (dateStr) => {
  if (!dateStr) return 0;
  try {
    const dateRegex = /(20\d{2}|令和\s*?\d+|令和\s*?元)年\s*?(\d{1,2})月\s*?(\d{1,2})日/;
    const match = dateStr.match(dateRegex);
    if (!match) return 0;

    let year, month, day;
    const fullMatch = match[0];
    
    if (fullMatch.includes('令和')) {
      const reiwaYearStr = fullMatch.match(/令和\s*?(\d+|元)年/)[1];
      year = reiwaYearStr === '元' ? 2019 : 2018 + parseInt(reiwaYearStr, 10);
    } else {
      year = parseInt(fullMatch.match(/(\d{4})年/)[1], 10);
    }
    month = parseInt(fullMatch.match(/(\d{1,2})月/)[1], 10) - 1;
    day = parseInt(fullMatch.match(/(\d{1,2})日/)[1], 10);
    
    return new Date(year, month, day).getTime();
  } catch (e) {
    return 0;
  }
};

const loadXlsxLibrary = () => {
  return new Promise((resolve, reject) => {
    if (window.XLSX) { resolve(window.XLSX); return; }
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    script.onload = () => resolve(window.XLSX);
    script.onerror = reject;
    document.body.appendChild(script);
  });
};

export default function App() {
  const [user, setUser] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });
  const [newMeeting, setNewMeeting] = useState({ meetingName: '', agency: '', url: '' });
  const fileInputRef = useRef(null);

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (e) { setError("認証に失敗しました。プロジェクトの設定を確認してください。"); }
    };
    initAuth();
    return onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (!user) return;
    const meetingsCol = collection(db, 'artifacts', appId, 'public', 'data', 'meetings');
    const unsubscribe = onSnapshot(query(meetingsCol), 
      (snapshot) => {
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        // 更新ありを優先表示
        data.sort((a, b) => {
          if (a.status === 'updated' && b.status !== 'updated') return -1;
          if (a.status !== 'updated' && b.status === 'updated') return 1;
          return (b.latestDateTimestamp || 0) - (a.latestDateTimestamp || 0);
        });
        setMeetings(data);
        setLoading(false);
      }, 
      (err) => { setError(`データ取得エラー: ${err.code}`); setLoading(false); }
    );
    return () => unsubscribe();
  }, [user]);

  const resetStatus = async (meeting) => {
    try {
      const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'meetings', meeting.id);
      await updateDoc(docRef, { status: 'unchanged' });
    } catch (e) { console.error(e); }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newMeeting.url.startsWith('http')) {
      alert("URLはhttp://またはhttps://で入力してください");
      return;
    }
    setIsProcessing(true);
    try {
      const docId = btoa(newMeeting.url).replace(/\//g, '_').substring(0, 50);
      const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'meetings', docId);
      
      await setDoc(docRef, {
        ...newMeeting,
        status: 'unchanged',
        latestDateString: '',
        latestDateTimestamp: 0,
        previousDateString: '',
        lastCheckedAt: serverTimestamp(),
        createdAt: serverTimestamp()
      }, { merge: true });
      
      setShowAddModal(false);
      setNewMeeting({ meetingName: '', agency: '', url: '' });
    } catch (e) {
      console.error(e);
      alert("追加に失敗しました。");
    } finally { setIsProcessing(false); }
  };

  const handleFileImport = async (event) => {
    const file = event.target.files[0];
    if (!file || !user) return;
    if (!window.confirm("現在の全データを削除し、ファイルの内容で上書きします。よろしいですか？")) return;

    setIsProcessing(true);
    try {
      let importedData = [];
      if (file.name.endsWith('.csv')) {
        const text = await file.text();
        const lines = text.split(/\r?\n/);
        const headers = lines[0].split(',').map(h => h.trim().replace(/^"(.*)"$/, '$1'));
        importedData = lines.slice(1).filter(l => l.trim()).map(line => {
          const cols = line.split(',').map(c => c.trim().replace(/^"(.*)"$/, '$1'));
          const obj = {};
          headers.forEach((h, i) => obj[h] = cols[i]);
          return obj;
        });
      } else {
        const XLSX = await loadXlsxLibrary();
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array' });
        importedData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
      }

      const validRecords = importedData.filter(r => r['会議名'] && r['URL']);
      setImportProgress({ current: 0, total: validRecords.length });

      const meetingsCol = collection(db, 'artifacts', appId, 'public', 'data', 'meetings');
      const currentDocs = await getDocs(meetingsCol);
      for (const d of currentDocs.docs) { await deleteDoc(d.ref); }

      for (let i = 0; i < validRecords.length; i++) {
        const record = validRecords[i];
        const docId = btoa(record['URL']).replace(/\//g, '_').substring(0, 50);
        const dateStr = record['直近開催日'] || record['日付'] || '';
        const timestamp = parseJapaneseDateToTs(dateStr);

        await setDoc(doc(meetingsCol, docId), {
          meetingName: record['会議名'],
          agency: record['所管'] || record['省庁'] || '-',
          url: record['URL'],
          status: 'unchanged',
          latestDateString: dateStr,
          latestDateTimestamp: timestamp,
          previousDateString: '',
          lastCheckedAt: serverTimestamp()
        });
        setImportProgress(prev => ({ ...prev, current: i + 1 }));
      }
      setShowImportModal(false);
      alert("一括インポートが完了しました。");
    } catch (e) { alert(`インポートエラー: ${e.message}`); } finally { setIsProcessing(false); event.target.value = ''; }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    setIsProcessing(true);
    try {
      const currentMeeting = meetings.find(m => m.id === editTarget.id);
      const newTimestamp = parseJapaneseDateToTs(editTarget.latestDateString);
      
      const updatePayload = {
        ...editTarget,
        latestDateTimestamp: newTimestamp,
        lastModifiedAt: serverTimestamp()
      };

      if (currentMeeting && currentMeeting.latestDateString !== editTarget.latestDateString) {
        updatePayload.previousDateString = currentMeeting.latestDateString;
        updatePayload.status = 'updated'; 
      }

      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'meetings', editTarget.id), updatePayload);
      setEditTarget(null);
    } finally { setIsProcessing(false); }
  };

  const handleDelete = async () => {
    setIsProcessing(true);
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'meetings', deleteTarget.id));
      setDeleteTarget(null);
    } finally { setIsProcessing(false); }
  };

  const filteredMeetings = meetings.filter(m => {
    const matchesFilter = filter === 'all' ? true : m.status === filter;
    const q = searchQuery.toLowerCase();
    return matchesFilter && (m.meetingName?.toLowerCase().includes(q) || m.agency?.toLowerCase().includes(q));
  });

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 text-slate-900 font-sans">
      <div className="max-w-6xl mx-auto space-y-6">
        
        {/* ヘッダー */}
        <header className="bg-white p-6 rounded-[2.5rem] shadow-sm border border-slate-200 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="bg-indigo-600 p-4 rounded-3xl shadow-xl shadow-indigo-100 transform -rotate-3">
              <Database className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-slate-800 tracking-tighter uppercase italic">Strategy Monitor</h1>
              <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest">会議体更新監視ダッシュボード</p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowImportModal(true)} className="flex items-center gap-2 px-6 py-3 bg-white border-2 border-slate-100 text-slate-600 rounded-2xl font-black text-sm hover:bg-slate-50 transition-all shadow-sm active:scale-95">
              <FileUp className="w-4 h-4" /> 一括インポート
            </button>
            <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 px-6 py-3 bg-indigo-600 text-white rounded-2xl font-black text-sm hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 active:scale-95">
              <Plus className="w-4 h-4" /> 新規追加
            </button>
          </div>
        </header>

        {/* 検索・フィルター */}
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <div className="flex bg-white p-1.5 rounded-2xl border border-slate-200 shadow-sm w-full md:w-auto overflow-x-auto">
            {[
              { id: 'all', label: 'すべて' },
              { id: 'updated', label: '更新あり' },
              { id: 'error', label: 'エラー' }
            ].map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)} className={`whitespace-nowrap px-5 py-2 rounded-xl text-xs font-black uppercase tracking-wider transition-all ${filter === f.id ? 'bg-indigo-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-600'}`}>
                {f.label} {f.id !== 'all' && `(${meetings.filter(m => m.status === f.id).length})`}
              </button>
            ))}
          </div>
          <div className="relative flex-1 group w-full">
            <Search className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300 group-focus-within:text-indigo-500 transition-colors" />
            <input type="text" placeholder="会議体名や省庁名で検索..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="w-full pl-12 pr-6 py-4 bg-white border border-slate-200 rounded-[1.5rem] focus:ring-4 focus:ring-indigo-500/10 focus:border-indigo-500 outline-none transition-all font-bold text-sm shadow-sm" />
          </div>
        </div>

        {/* データテーブル */}
        <div className="bg-white rounded-[3rem] shadow-sm border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="bg-slate-50/50 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">
                  <th className="p-8">状態</th>
                  <th className="p-8">会議体 / 所管</th>
                  <th className="p-8">開催日の比較 (前回 → 最新)</th>
                  <th className="p-8 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {filteredMeetings.map(m => (
                  <tr key={m.id} className="hover:bg-indigo-50/30 transition-colors group">
                    <td className="p-8 align-top">
                      <button 
                        onClick={() => m.status === 'updated' && resetStatus(m)}
                        className={`inline-flex items-center gap-2 px-4 py-2 rounded-2xl text-[10px] font-black border uppercase tracking-wider transition-all ${m.status === 'updated' ? 'bg-green-50 text-green-600 border-green-200 hover:bg-green-100 cursor-pointer shadow-sm' : m.status === 'error' ? 'bg-red-50 text-red-600 border-red-100' : 'bg-slate-50 text-slate-400 border-slate-100'}`}
                      >
                        <div className={`w-2 h-2 rounded-full ${m.status === 'updated' ? 'bg-green-500 animate-pulse' : m.status === 'error' ? 'bg-red-500' : 'bg-slate-300'}`}></div>
                        {m.status === 'updated' ? '確認済みにする' : m.status === 'error' ? 'エラー' : '変更なし'}
                      </button>
                    </td>
                    <td className="p-8 align-top">
                      <div className="font-black text-slate-800 text-lg leading-tight mb-2">{m.meetingName}</div>
                      <div className="flex items-center gap-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        <span className="bg-slate-100 px-2 py-0.5 rounded">{m.agency}</span>
                        <span className="opacity-40 truncate max-w-[200px] font-mono lowercase">{m.url}</span>
                      </div>
                    </td>
                    <td className="p-8 align-top">
                      <div className="flex items-center gap-3">
                        {m.status === 'updated' && m.previousDateString ? (
                          <>
                            <div className="text-sm font-bold text-slate-300 line-through decoration-slate-200 font-mono">
                              {m.previousDateString}
                            </div>
                            <ArrowRight className="w-4 h-4 text-indigo-300" />
                          </>
                        ) : null}
                        <div className={`text-xl font-black font-mono leading-none ${m.status === 'updated' ? 'text-indigo-600' : 'text-slate-600'}`}>
                          {m.latestDateString || '---'}
                        </div>
                      </div>
                      <div className="text-[9px] text-slate-300 font-black mt-3 uppercase tracking-tighter">
                        {m.lastCheckedAt ? `最終同期: ${new Date(m.lastCheckedAt.toDate()).toLocaleString('ja-JP')}` : '未同期'}
                      </div>
                    </td>
                    <td className="p-8 align-top text-right">
                      <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-all translate-x-4 group-hover:translate-x-0">
                        <a href={m.url} target="_blank" rel="noreferrer" className="p-3 text-slate-300 hover:text-indigo-600 hover:bg-white rounded-2xl border border-transparent hover:border-slate-100 shadow-none hover:shadow-lg transition-all" title="サイトを開く"><ExternalLink className="w-5 h-5"/></a>
                        <button onClick={() => setEditTarget(m)} className="p-3 text-slate-300 hover:text-blue-600 hover:bg-white rounded-2xl border border-transparent hover:border-slate-100 shadow-none hover:shadow-lg transition-all" title="編集"><Edit3 className="w-5 h-5"/></button>
                        <button onClick={() => setDeleteTarget(m)} className="p-3 text-slate-300 hover:text-red-600 hover:bg-white rounded-2xl border border-transparent hover:border-slate-100 shadow-none hover:shadow-lg transition-all" title="削除"><Trash2 className="w-5 h-5"/></button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredMeetings.length === 0 && !loading && (
                   <tr>
                     <td colSpan="4" className="p-12 text-center text-slate-400 font-bold">データが見つかりません</td>
                   </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* モーダル: 新規追加 */}
      {showAddModal && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-300">
            <div className="p-8 border-b border-slate-50 flex justify-between items-center">
              <h2 className="text-xl font-black text-slate-800">新規会議体の追加</h2>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-slate-600"><X className="w-6 h-6"/></button>
            </div>
            <form onSubmit={handleAdd} className="p-8 space-y-6">
              <div className="space-y-1">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">会議体名</label>
                <input type="text" value={newMeeting.meetingName} onChange={e => setNewMeeting({...newMeeting, meetingName: e.target.value})} className="w-full px-5 py-3.5 bg-slate-100 border-none rounded-2xl focus:ring-4 focus:ring-indigo-500/20 outline-none font-bold" placeholder="例: 第〇回 〇〇会議" required />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">所管 / 省庁</label>
                <input type="text" value={newMeeting.agency} onChange={e => setNewMeeting({...newMeeting, agency: e.target.value})} className="w-full px-5 py-3.5 bg-slate-100 border-none rounded-2xl focus:ring-4 focus:ring-indigo-500/20 outline-none font-bold" placeholder="例: 内閣府" required />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">監視URL</label>
                <input type="url" value={newMeeting.url} onChange={e => setNewMeeting({...newMeeting, url: e.target.value})} className="w-full px-5 py-3.5 bg-slate-100 border-none rounded-2xl focus:ring-4 focus:ring-indigo-500/20 outline-none font-bold" placeholder="https://..." required />
              </div>
              <div className="pt-4 flex gap-4">
                <button type="submit" disabled={isProcessing} className="w-full px-6 py-4 bg-indigo-600 text-white rounded-2xl font-black hover:bg-indigo-700 shadow-xl shadow-indigo-100 disabled:opacity-50">
                  {isProcessing ? "処理中..." : "追加する"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* モーダル: インポート */}
      {showImportModal && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-[3rem] shadow-2xl w-full max-w-lg overflow-hidden p-12 text-center animate-in fade-in zoom-in duration-300">
            <FileUp className="w-16 h-16 text-indigo-600 mx-auto mb-8" />
            <h2 className="text-3xl font-black text-slate-900 mb-4 tracking-tighter uppercase">一括上書きインポート</h2>
            <p className="text-sm font-bold text-slate-400 mb-10 leading-relaxed px-8">
              既存の全データを削除し、新しいファイルで監視リストを再構築します。<br />この操作は取り消せません。
            </p>
            {isProcessing ? (
              <div className="animate-pulse text-indigo-600 font-black tracking-widest uppercase">処理中: {importProgress.current}/{importProgress.total}</div>
            ) : (
              <div className="flex flex-col gap-4">
                <button onClick={() => fileInputRef.current.click()} className="w-full py-5 bg-indigo-600 text-white rounded-[2rem] font-black text-lg shadow-xl shadow-indigo-100 transition-all hover:bg-indigo-700 active:scale-95">ファイルを選択して実行</button>
                <button onClick={() => setShowImportModal(false)} className="w-full py-5 text-slate-300 font-black hover:text-slate-500">キャンセル</button>
              </div>
            )}
            <input type="file" ref={fileInputRef} onChange={handleFileImport} className="hidden" accept=".csv, .xlsx, .xls" />
          </div>
        </div>
      )}

      {/* モーダル: 編集 */}
      {editTarget && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-md p-10 animate-in fade-in zoom-in duration-300">
            <h2 className="text-2xl font-black text-slate-900 mb-8 font-mono tracking-tighter uppercase">会議体のプロパティを編集</h2>
            <form onSubmit={handleUpdate} className="space-y-5">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 ml-2 uppercase tracking-widest">会議体名</label>
                <input type="text" value={editTarget.meetingName} onChange={e => setEditTarget({...editTarget, meetingName: e.target.value})} className="w-full px-6 py-4 bg-slate-100 border-none rounded-2xl font-bold text-slate-700 outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 ml-2 uppercase tracking-widest">所管 / 省庁</label>
                <input type="text" value={editTarget.agency} onChange={e => setEditTarget({...editTarget, agency: e.target.value})} className="w-full px-6 py-4 bg-slate-100 border-none rounded-2xl font-bold text-slate-700 outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 ml-2 uppercase tracking-widest">監視URL</label>
                <input type="text" value={editTarget.url} onChange={e => setEditTarget({...editTarget, url: e.target.value})} className="w-full px-6 py-4 bg-slate-100 border-none rounded-2xl font-bold text-slate-700 outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 ml-2 uppercase tracking-widest">直近開催日 (手動修正用)</label>
                <input type="text" value={editTarget.latestDateString} onChange={e => setEditTarget({...editTarget, latestDateString: e.target.value})} className="w-full px-6 py-4 bg-slate-100 border-none rounded-2xl font-bold text-slate-700 outline-none focus:ring-2 focus:ring-indigo-500/20" />
              </div>
              <div className="flex gap-4 pt-6">
                <button type="button" onClick={() => setEditTarget(null)} className="flex-1 font-black text-slate-300 hover:text-slate-500 transition-colors uppercase tracking-widest">閉じる</button>
                <button type="submit" disabled={isProcessing} className="flex-2 px-8 py-4 bg-indigo-600 text-white rounded-2xl font-black shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all">変更を保存</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* モーダル: 削除確認 */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-md flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-[3rem] shadow-2xl w-full max-w-sm p-12 text-center animate-in fade-in zoom-in duration-300">
            <div className="w-24 h-24 bg-red-50 text-red-500 rounded-[2.5rem] flex items-center justify-center mx-auto mb-8 transform rotate-6 animate-pulse"><AlertCircle className="w-12 h-12" /></div>
            <h2 className="text-3xl font-black text-slate-900 mb-4 tracking-tighter uppercase">データを削除しますか？</h2>
            <p className="text-sm font-bold text-slate-400 mb-10 leading-relaxed px-4">「{deleteTarget.meetingName}」をリストから完全に消去します。</p>
            <div className="flex gap-4">
              <button onClick={() => setDeleteTarget(null)} className="flex-1 py-5 border-2 border-slate-100 rounded-[2rem] font-black text-slate-300 hover:text-slate-500 transition-colors">いいえ</button>
              <button onClick={handleDelete} className="flex-1 py-5 bg-red-500 text-white rounded-[2rem] font-black shadow-xl shadow-red-100 hover:bg-red-600 transition-all">はい、削除します</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}