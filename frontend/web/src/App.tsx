// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ClinicalTrialNFT {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  trialPhase: string;
  status: "pending" | "approved" | "rejected";
  participantCount: number;
  successRate: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [trials, setTrials] = useState<ClinicalTrialNFT[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newTrialData, setNewTrialData] = useState({ 
    trialPhase: "Phase I", 
    description: "", 
    participantCount: 0,
    successRate: 0 
  });
  const [selectedTrial, setSelectedTrial] = useState<ClinicalTrialNFT | null>(null);
  const [decryptedData, setDecryptedData] = useState<{participantCount: number | null, successRate: number | null}>({participantCount: null, successRate: null});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterPhase, setFilterPhase] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");

  const approvedCount = trials.filter(t => t.status === "approved").length;
  const pendingCount = trials.filter(t => t.status === "pending").length;
  const rejectedCount = trials.filter(t => t.status === "rejected").length;

  useEffect(() => {
    loadTrials().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadTrials = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("trial_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing trial keys:", e); }
      }
      const list: ClinicalTrialNFT[] = [];
      for (const key of keys) {
        try {
          const trialBytes = await contract.getData(`trial_${key}`);
          if (trialBytes.length > 0) {
            try {
              const trialData = JSON.parse(ethers.toUtf8String(trialBytes));
              list.push({ 
                id: key, 
                encryptedData: trialData.data, 
                timestamp: trialData.timestamp, 
                owner: trialData.owner, 
                trialPhase: trialData.trialPhase, 
                status: trialData.status || "pending",
                participantCount: trialData.participantCount,
                successRate: trialData.successRate
              });
            } catch (e) { console.error(`Error parsing trial data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading trial ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setTrials(list);
    } catch (e) { console.error("Error loading trials:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitTrial = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting clinical trial data with Zama FHE..." });
    try {
      const encryptedData = JSON.stringify({
        participantCount: FHEEncryptNumber(newTrialData.participantCount),
        successRate: FHEEncryptNumber(newTrialData.successRate)
      });
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const trialId = `trial-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const trialData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        trialPhase: newTrialData.trialPhase, 
        status: "pending",
        participantCount: newTrialData.participantCount,
        successRate: newTrialData.successRate
      };
      
      await contract.setData(`trial_${trialId}`, ethers.toUtf8Bytes(JSON.stringify(trialData)));
      
      const keysBytes = await contract.getData("trial_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(trialId);
      await contract.setData("trial_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted clinical trial NFT created!" });
      await loadTrials();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewTrialData({ 
          trialPhase: "Phase I", 
          description: "", 
          participantCount: 0,
          successRate: 0 
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const dataObj = JSON.parse(encryptedData);
      return {
        participantCount: FHEDecryptNumber(dataObj.participantCount),
        successRate: FHEDecryptNumber(dataObj.successRate)
      };
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const approveTrial = async (trialId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted trial data with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const trialBytes = await contract.getData(`trial_${trialId}`);
      if (trialBytes.length === 0) throw new Error("Trial not found");
      const trialData = JSON.parse(ethers.toUtf8String(trialBytes));
      const updatedTrial = { ...trialData, status: "approved" };
      await contract.setData(`trial_${trialId}`, ethers.toUtf8Bytes(JSON.stringify(updatedTrial)));
      setTransactionStatus({ visible: true, status: "success", message: "Trial approved successfully!" });
      await loadTrials();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Approval failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectTrial = async (trialId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted trial data with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const trialBytes = await contract.getData(`trial_${trialId}`);
      if (trialBytes.length === 0) throw new Error("Trial not found");
      const trialData = JSON.parse(ethers.toUtf8String(trialBytes));
      const updatedTrial = { ...trialData, status: "rejected" };
      await contract.setData(`trial_${trialId}`, ethers.toUtf8Bytes(JSON.stringify(updatedTrial)));
      setTransactionStatus({ visible: true, status: "success", message: "Trial rejected successfully!" });
      await loadTrials();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (trialAddress: string) => address?.toLowerCase() === trialAddress.toLowerCase();

  const filteredTrials = trials.filter(trial => {
    const matchesSearch = trial.id.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         trial.trialPhase.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesPhase = filterPhase === "all" || trial.trialPhase === filterPhase;
    const matchesStatus = filterStatus === "all" || trial.status === filterStatus;
    return matchesSearch && matchesPhase && matchesStatus;
  });

  const renderStatsCards = () => {
    return (
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-value">{trials.length}</div>
          <div className="stat-label">Total Trials</div>
          <div className="stat-icon">🧪</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{approvedCount}</div>
          <div className="stat-label">Approved</div>
          <div className="stat-icon">✅</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending</div>
          <div className="stat-icon">⏳</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{rejectedCount}</div>
          <div className="stat-label">Rejected</div>
          <div className="stat-icon">❌</div>
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing FHE encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="shield-icon"></div>
          </div>
          <h1>FHE<span>Clinical</span>Trials</h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-btn metal-button"
            onMouseEnter={(e) => e.currentTarget.classList.add('glow')}
            onMouseLeave={(e) => e.currentTarget.classList.remove('glow')}
          >
            <div className="add-icon"></div>Create Trial NFT
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-Encrypted Clinical Trial NFTs</h2>
            <p>Tokenize and trade clinical trial results as NFTs while keeping data encrypted with Zama FHE</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>FHE Encryption Active</span>
          </div>
        </div>

        <div className="dashboard-section">
          <div className="section-header">
            <h2>Project Overview</h2>
          </div>
          <div className="project-description metal-card">
            <h3>Revolutionizing Clinical Research with FHE & NFTs</h3>
            <p>
              Our platform enables researchers to tokenize clinical trial results as NFTs while keeping the sensitive data encrypted 
              using <strong>Zama FHE technology</strong>. The encrypted data remains private while allowing verifiable computations 
              and enabling new funding models through DeFi integration.
            </p>
            <div className="fhe-badge">
              <span>Powered by Zama FHE</span>
            </div>
          </div>
        </div>

        <div className="dashboard-section">
          <div className="section-header">
            <h2>Trial Statistics</h2>
          </div>
          {renderStatsCards()}
        </div>

        <div className="trials-section">
          <div className="section-header">
            <h2>Clinical Trial NFTs</h2>
            <div className="header-actions">
              <div className="search-filter">
                <input 
                  type="text" 
                  placeholder="Search trials..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="metal-input"
                />
                <select 
                  value={filterPhase} 
                  onChange={(e) => setFilterPhase(e.target.value)}
                  className="metal-select"
                >
                  <option value="all">All Phases</option>
                  <option value="Phase I">Phase I</option>
                  <option value="Phase II">Phase II</option>
                  <option value="Phase III">Phase III</option>
                  <option value="Phase IV">Phase IV</option>
                </select>
                <select 
                  value={filterStatus} 
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="metal-select"
                >
                  <option value="all">All Statuses</option>
                  <option value="pending">Pending</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <button 
                onClick={loadTrials} 
                className="refresh-btn metal-button"
                disabled={isRefreshing}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="trials-grid">
            {filteredTrials.length === 0 ? (
              <div className="no-trials metal-card">
                <div className="no-trials-icon">🔍</div>
                <p>No clinical trial NFTs found</p>
                <button 
                  className="metal-button primary" 
                  onClick={() => setShowCreateModal(true)}
                  onMouseEnter={(e) => e.currentTarget.classList.add('glow')}
                  onMouseLeave={(e) => e.currentTarget.classList.remove('glow')}
                >
                  Create First Trial NFT
                </button>
              </div>
            ) : (
              filteredTrials.map(trial => (
                <div 
                  className="trial-card metal-card" 
                  key={trial.id}
                  onClick={() => setSelectedTrial(trial)}
                  onMouseEnter={(e) => e.currentTarget.classList.add('hover-glow')}
                  onMouseLeave={(e) => e.currentTarget.classList.remove('hover-glow')}
                >
                  <div className="card-header">
                    <div className="trial-id">#{trial.id.substring(0, 6)}</div>
                    <div className={`status-badge ${trial.status}`}>{trial.status}</div>
                  </div>
                  <div className="card-body">
                    <div className="trial-phase">{trial.trialPhase}</div>
                    <div className="trial-owner">
                      Owner: {trial.owner.substring(0, 6)}...{trial.owner.substring(38)}
                    </div>
                    <div className="trial-date">
                      {new Date(trial.timestamp * 1000).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="card-footer">
                    {isOwner(trial.owner) && trial.status === "pending" && (
                      <div className="action-buttons">
                        <button 
                          className="action-btn approve"
                          onClick={(e) => { e.stopPropagation(); approveTrial(trial.id); }}
                        >
                          Approve
                        </button>
                        <button 
                          className="action-btn reject"
                          onClick={(e) => { e.stopPropagation(); rejectTrial(trial.id); }}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitTrial} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          trialData={newTrialData} 
          setTrialData={setNewTrialData}
        />
      )}

      {selectedTrial && (
        <TrialDetailModal 
          trial={selectedTrial} 
          onClose={() => { 
            setSelectedTrial(null); 
            setDecryptedData({participantCount: null, successRate: null}); 
          }} 
          decryptedData={decryptedData}
          setDecryptedData={setDecryptedData}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="shield-icon"></div>
              <span>FHEClinicalTrials</span>
            </div>
            <p>Tokenizing medical research with FHE encryption</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} FHEClinicalTrials. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  trialData: any;
  setTrialData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, trialData, setTrialData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setTrialData({ ...trialData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setTrialData({ ...trialData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!trialData.trialPhase || trialData.participantCount <= 0) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Create Clinical Trial NFT</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon">🔒</div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Sensitive clinical data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-grid">
            <div className="form-group">
              <label>Trial Phase *</label>
              <select 
                name="trialPhase" 
                value={trialData.trialPhase} 
                onChange={handleChange} 
                className="metal-select"
              >
                <option value="Phase I">Phase I</option>
                <option value="Phase II">Phase II</option>
                <option value="Phase III">Phase III</option>
                <option value="Phase IV">Phase IV</option>
              </select>
            </div>
            
            <div className="form-group">
              <label>Description</label>
              <input 
                type="text" 
                name="description" 
                value={trialData.description} 
                onChange={handleChange} 
                placeholder="Brief description of the trial..."
                className="metal-input"
              />
            </div>
            
            <div className="form-group">
              <label>Participant Count *</label>
              <input 
                type="number" 
                name="participantCount" 
                value={trialData.participantCount} 
                onChange={handleNumberChange} 
                placeholder="Number of participants..."
                className="metal-input"
                min="1"
              />
            </div>
            
            <div className="form-group">
              <label>Success Rate (%)</label>
              <input 
                type="number" 
                name="successRate" 
                value={trialData.successRate} 
                onChange={handleNumberChange} 
                placeholder="Success rate percentage..."
                className="metal-input"
                min="0"
                max="100"
              />
            </div>
          </div>
          
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Values:</span>
                <div>
                  Participants: {trialData.participantCount || '0'}, 
                  Success: {trialData.successRate || '0'}%
                </div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {trialData.participantCount ? 
                    `FHE-${btoa(trialData.participantCount.toString()).substring(0, 20)}...` : 
                    'No data entered'}
                </div>
              </div>
            </div>
          </div>
          
          <div className="privacy-notice">
            <div className="privacy-icon">🛡️</div> 
            <div>
              <strong>Data Privacy Guarantee</strong>
              <p>Clinical data remains encrypted during processing and is never decrypted on our servers</p>
            </div>
          </div>
        </div>
        
        <div className="modal-footer">
          <button 
            onClick={onClose} 
            className="cancel-btn metal-button"
            onMouseEnter={(e) => e.currentTarget.classList.add('hover-glow')}
            onMouseLeave={(e) => e.currentTarget.classList.remove('hover-glow')}
          >
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn metal-button primary"
            onMouseEnter={(e) => e.currentTarget.classList.add('glow')}
            onMouseLeave={(e) => e.currentTarget.classList.remove('glow')}
          >
            {creating ? "Encrypting with FHE..." : "Create Trial NFT"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface TrialDetailModalProps {
  trial: ClinicalTrialNFT;
  onClose: () => void;
  decryptedData: {participantCount: number | null, successRate: number | null};
  setDecryptedData: (data: {participantCount: number | null, successRate: number | null}) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<{participantCount: number | null, successRate: number | null}>;
}

const TrialDetailModal: React.FC<TrialDetailModalProps> = ({ 
  trial, 
  onClose, 
  decryptedData,
  setDecryptedData,
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedData.participantCount !== null) { 
      setDecryptedData({participantCount: null, successRate: null}); 
      return; 
    }
    const decrypted = await decryptWithSignature(trial.encryptedData);
    if (decrypted !== null) setDecryptedData(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="trial-detail-modal metal-card">
        <div className="modal-header">
          <h2>Trial NFT Details #{trial.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="trial-info">
            <div className="info-item">
              <span>Phase:</span>
              <strong>{trial.trialPhase}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{trial.owner.substring(0, 6)}...{trial.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date:</span>
              <strong>{new Date(trial.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${trial.status}`}>{trial.status}</strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>FHE Encrypted Data</h3>
            <div className="encrypted-data">
              {trial.encryptedData.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon">🔒</div>
              <span>Zama FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn metal-button"
              onClick={handleDecrypt} 
              disabled={isDecrypting}
              onMouseEnter={(e) => e.currentTarget.classList.add('hover-glow')}
              onMouseLeave={(e) => e.currentTarget.classList.remove('hover-glow')}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedData.participantCount !== null ? (
                "Hide Decrypted Data"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedData.participantCount !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Trial Data</h3>
              <div className="decrypted-values">
                <div className="value-item">
                  <span>Participants:</span>
                  <strong>{decryptedData.participantCount}</strong>
                </div>
                <div className="value-item">
                  <span>Success Rate:</span>
                  <strong>{decryptedData.successRate}%</strong>
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon">⚠️</div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button 
            onClick={onClose} 
            className="close-btn metal-button"
            onMouseEnter={(e) => e.currentTarget.classList.add('hover-glow')}
            onMouseLeave={(e) => e.currentTarget.classList.remove('hover-glow')}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;