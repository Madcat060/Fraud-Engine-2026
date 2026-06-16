/**
 * CaseAttachments.jsx – Evidence uploads for fraud cases.
 * Fetches and displays attachments for a case; uploads new files via FormData.
 */
import React, { useState, useEffect, useRef } from 'react';

const API = '';

export default function CaseAttachments({ caseId }) {
  const [attachments, setAttachments] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!caseId) return;
    setUploadError('');
    fetch(`${API}/api/cases/${caseId}/attachments`)
      .then((r) => r.json())
      .then((data) => {
        if (data.attachments && Array.isArray(data.attachments)) {
          setAttachments(data.attachments);
        } else {
          setAttachments([]);
        }
      })
      .catch((err) => {
        setUploadError(err.message || 'Failed to load attachments');
        setAttachments([]);
      });
  }, [caseId]);

  function handleFileUpload(event) {
    const file = event.target.files?.[0];
    if (!file || !caseId) return;

    setUploadError('');
    setIsUploading(true);

    const formData = new FormData();
    formData.append('file', file);

    fetch(`${API}/api/cases/${caseId}/attachments`, {
      method: 'POST',
      body: formData,
      // Do NOT set Content-Type; let the browser set multipart/form-data and boundary
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.status === 'success' && data.attachment) {
          event.target.value = '';
          // Refetch so we get the new row's id for the secure download link
          return fetch(`${API}/api/cases/${caseId}/attachments`)
            .then((r) => r.json())
            .then((refetchData) => {
              if (refetchData.attachments && Array.isArray(refetchData.attachments)) {
                setAttachments(refetchData.attachments);
              }
            });
        } else {
          setUploadError(data.error || 'Upload failed');
        }
      })
      .catch((err) => {
        setUploadError(err.message || 'Upload failed');
      })
      .finally(() => {
        setIsUploading(false);
      });
  }

  if (!caseId) return null;

  return (
    <section className="case-attachments-site" style={{ marginTop: '0.75rem' }}>
      <h3 className="case-attachments-site-title">
        Evidence & attachments
      </h3>

      {uploadError && (
        <p role="alert" style={{ color: '#dc2626', marginBottom: '0.5rem', fontSize: '0.9rem' }}>
          {uploadError}
        </p>
      )}

      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 1rem 0' }}>
        {attachments.length === 0 && !uploadError && (
          <li style={{ color: '#666', fontSize: '0.9rem' }}>No attachments yet.</li>
        )}
        {attachments.map((att) => (
          <li key={att.id != null ? att.id : att.file_name + (att.file_path || '')} style={{ marginBottom: '0.35rem' }}>
            {att.id != null ? (
              <a
                href={`${API}/api/cases/${caseId}/attachments/${att.id}/download`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#2563eb', textDecoration: 'underline' }}
              >
                {att.file_name}
              </a>
            ) : (
              <span>{att.file_name}</span>
            )}
          </li>
        ))}
      </ul>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileUpload}
          disabled={isUploading}
          style={{ fontSize: '0.9rem' }}
          aria-label="Choose file to upload"
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          style={{ cursor: isUploading ? 'not-allowed' : 'pointer' }}
        >
          {isUploading ? 'Uploading…' : 'Upload'}
        </button>
      </div>
    </section>
  );
}
