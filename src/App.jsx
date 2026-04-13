/**
 * React フロントエンド画面（実データ連携版）
 * * [重要]
 * Firebase コンソールから取得した設定値を反映済みです。
 */

import React, { useState, useEffect } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, onSnapshot, query } from 'firebase/firestore';
import { CheckCircle, Clock, AlertTriangle, ExternalLink, Search, RefreshCw } from 'lucide-react';

// --- Firebase クライアント設定 ---
const firebaseConfig = {
  apiKey: "AIzaSyBx5e752GWfvJDZ3lEx0IcArxjvCEz7S2M",
  authDomain: "seisakuresearch00.firebaseapp.com",
  projectId: "seisakuresearch00",
  storageBucket: "seisakuresearch00.firebasestorage.app",
  messagingSenderId: "356788263577",
  appId: "1:356788263577:web:ecc3782d0c82cb7da43608",
  measurementId: "G-Y1C3GPNC9Z"
};

// Firebase初期化（重複初期化を防止）
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const db = getFirestore(app);

export default function App() {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!db) {
      setError("Firebaseの設定が正しくありません。");
      setLoading(false);
      return;
    }

    // Firestoreの "meetings" コレクションをリアルタイム監視
    const q = query(collection(db, 'meetings'));
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      // サイト上の最新日付（またはチェック日時）の降順でソート
      data.sort((a, b) => {
        const timeA = a.latestDateTimestamp || 0;
        const timeB = b.latestDateTimestamp || 0;
        return timeB - timeA;
      });

      setMeetings(data);
      setLoading(false);
    }, (err) => {
      console.error("Firestore Subscribe Error:", err);
      setError("データの取得に失敗しました。Firebaseのセキュリティルールを確認してください。");
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const getStatusBadge = (status) => {
    switch (status) {
      case 'updated':
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800"><CheckCircle className="w-3 h-3 mr-1" /> 新規更新</span>;
      case 'unchanged':
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800"><Clock className="w-3 h-3 mr-1" /> 更新なし</span>;
      case 'error':
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800"><AlertTriangle className="w-3 h-3 mr-1" /> エラー</span>;
      default:
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">未チェック</span>;
    }
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return '-';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleString('ja-JP', { 
      year: 'numeric', month: '2-digit', day: '2-digit', 
      hour: '2-digit', minute: '2-digit' 
    });
  };

  const updatedCount = meetings.filter(m => m.status === 'updated').length;

  return (
    <div className="min-h-screen bg-gray-50 p-6 font-sans text-gray-900">
      <div className="max-w-6xl mx-auto space-y-6">
        
        {/* ヘッダー */}
        <div className="flex flex-col md:flex-row md:items-center justify-between bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              <Search className="w-6 h-6 text-indigo-600" />
              会議体ダッシュボード
            </h1>
            <p className="text-sm text-gray-500 mt-1">Firebase Firestoreのデータを表示しています</p>
          </div>
          <div className="mt-4 md:mt-0 flex gap-4 text-sm text-gray-500 items-center">
             {loading && <span className="flex items-center gap-1 animate-pulse"><RefreshCw className="w-4 h-4 animate-spin" /> 同期中...</span>}
             <span className="bg-gray-100 px-3 py-1 rounded-full">監視数: {meetings.length}件</span>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-md">
            <p className="text-sm text-red-700 font-bold">エラーが発生しました</p>
            <p className="text-xs text-red-600 mt-1">{error}</p>
          </div>
        )}

        {/* サマリーカード */}
        {!loading && !error && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white p-5 rounded-xl border border-gray-100 shadow-sm">
              <span className="text-sm font-medium text-gray-500">総監視件数</span>
              <span className="block text-3xl font-bold text-gray-900 mt-2">{meetings.length}</span>
            </div>
            <div className="bg-white p-5 rounded-xl border border-green-100 shadow-sm relative overflow-hidden">
              <div className="absolute top-0 right-0 p-4 opacity-5 text-green-600"><CheckCircle className="w-12 h-12" /></div>
              <span className="text-sm font-medium text-green-600">新規更新あり（未確認）</span>
              <span className="block text-3xl font-bold text-green-700 mt-2">{updatedCount}</span>
            </div>
            <div className="bg-white p-5 rounded-xl border border-red-100 shadow-sm">
              <span className="text-sm font-medium text-red-500">取得エラー</span>
              <span className="block text-3xl font-bold text-red-700 mt-2">{meetings.filter(m => m.status === 'error').length}</span>
            </div>
          </div>
        )}

        {/* メインテーブル */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-50 text-gray-600 font-medium border-b border-gray-200">
                <tr>
                  <th className="px-6 py-4">状態</th>
                  <th className="px-6 py-4">会議名 / 所管</th>
                  <th className="px-6 py-4">サイト上の最新日</th>
                  <th className="px-6 py-4">最終確認日時</th>
                  <th className="px-6 py-4 text-right">リンク</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {meetings.map((record) => (
                  <tr key={record.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      {getStatusBadge(record.status)}
                    </td>
                    <td className="px-6 py-4">
                      <div className="font-medium text-gray-900">{record.meetingName || '名称不明'}</div>
                      <div className="text-xs text-gray-500 mt-1">{record.agency || '-'}</div>
                      {record.status === 'error' && (
                        <div className="text-xs text-red-500 mt-1 font-mono italic">
                          {record.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {record.latestDateString ? (
                        <span className={`font-bold px-2 py-1 rounded ${record.status === 'updated' ? 'text-green-700 bg-green-100' : 'text-gray-700'}`}>
                          {record.latestDateString}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-gray-500 whitespace-nowrap text-xs font-mono">
                      {formatDate(record.lastCheckedAt)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      {record.url ? (
                        <a 
                          href={record.url} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}