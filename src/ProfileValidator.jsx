import React, { useState } from 'react';

// ==========================================
// 1. APPLE SCHEMAS (TopLevel & CommonPayload)
// ==========================================
const TOP_LEVEL_SCHEMA = {
  PayloadDescription: { type: 'string', required: false },
  PayloadDisplayName: { type: 'string', required: true },
  PayloadIdentifier: { type: 'string', required: true },
  PayloadOrganization: { type: 'string', required: false },
  PayloadRemovalDisallowed: { type: 'boolean', required: false },
  PayloadScope: { type: 'string', required: false, allowed: ['User', 'System'] },
  PayloadType: { type: 'string', required: true, fixedValue: 'Configuration' },
  PayloadUUID: { type: 'string', required: true },
  PayloadVersion: { type: 'integer', required: true },
  DurationUntilRemoval: { type: 'real', required: false },
  ConsentText: { type: 'dict', required: false },
  EncryptedPayloadContent: { type: 'data', required: false },
  PayloadContent: { type: 'array', required: false, isPayloadContentArray: true },
};

const COMMON_PAYLOAD_KEYS = {
  PayloadDescription: { type: 'string', required: false },
  PayloadDisplayName: { type: 'string', required: false },
  PayloadIdentifier: { type: 'string', required: true },
  PayloadOrganization: { type: 'string', required: false },
  PayloadType: { type: 'string', required: true },
  PayloadUUID: { type: 'string', required: true },
  PayloadVersion: { type: 'integer', required: true },
};

// ==========================================
// 2. HELPER FUNCTIONS: PARSING & GENERATION
// ==========================================
const parsePlistXmlToTree = (xmlString) => {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, "text/xml");
  
  const parseError = xmlDoc.getElementsByTagName("parsererror");
  if (parseError.length > 0) {
    throw new Error("Invalid XML structural format. Please check syntax closing tags.");
  }

  const plist = xmlDoc.getElementsByTagName("plist")[0];
  if (!plist) throw new Error("Missing root <plist> element.");

  const rootDict = plist.querySelector(":scope > dict");
  if (!rootDict) throw new Error("Root element inside <plist> must be a <dict>.");

  return parseDictNode(rootDict);
};

const parseDictNode = (dictNode) => {
  const children = Array.from(dictNode.children);
  const result = [];
  
  for (let i = 0; i < children.length; i++) {
    if (children[i].tagName.toLowerCase() === 'key') {
      const keyName = children[i].textContent.trim();
      const valueNode = children[i].nextElementSibling;
      if (valueNode && valueNode.tagName.toLowerCase() !== 'key') {
        result.push({
          key: keyName,
          ...parseValueNode(valueNode)
        });
      }
    }
  }
  return result;
};

const parseValueNode = (node) => {
  const type = node.tagName.toLowerCase();
  if (type === 'dict') {
    return { type: 'dict', value: parseDictNode(node) };
  } else if (type === 'array') {
    const items = Array.from(node.children).map(child => {
      if (child.tagName.toLowerCase() === 'dict') {
        return { type: 'dict', value: parseDictNode(child) };
      }
      return parseValueNode(child);
    });
    return { type: 'array', value: items };
  } else if (type === 'true' || type === 'false') {
    return { type: 'boolean', value: type === 'true' };
  } else {
    return { type: type, value: node.textContent.trim() };
  }
};

const convertTreeToPlist = (treeData) => {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`;
  xml += `<plist version="1.0">\n`;
  
  const renderDict = (dictArray, indent = '  ') => {
    let out = `${indent}<dict>\n`;
    dictArray.forEach(item => {
      out += `${indent}  <key>${item.key}</key>\n`;
      out += renderValue(item.type, item.value, indent + '  ');
    });
    out += `${indent}</dict>\n`;
    return out;
  };

  const renderValue = (type, val, indent) => {
    if (type === 'dict') return renderDict(val, indent);
    if (type === 'boolean') return `${indent}<${val ? 'true' : 'false'}/>\n`;
    if (type === 'array') {
      let out = `${indent}<array>\n`;
      val.forEach(subItem => {
        if (subItem.type === 'dict') {
          out += renderDict(subItem.value, indent + '  ');
        } else {
          out += renderValue(subItem.type, subItem.value, indent + '  ');
        }
      });
      out += `${indent}</array>\n`;
      return out;
    }
    return `${indent}<${type}>${val}</${type}>\n`;
  };

  xml += renderDict(treeData);
  xml += `</plist>`;
  return xml;
};

const validateTree = (tree, schema, isPayloadContentItems = false) => {
  let updatedTree = [...tree];
  const foundKeys = updatedTree.map(item => item.key);

  updatedTree = updatedTree.map(node => {
    const rules = schema[node.key];
    
    if (!rules) {
      return { ...node, errorType: 'UNEXPECTED', errorMessage: 'Unexpected profile payload key.' };
    }
    
    if (node.type !== rules.type) {
      return { 
        ...node, 
        errorType: 'WRONG_TYPE', 
        expectedType: rules.type, 
        errorMessage: `Type mismatch. Expected <${rules.type}> but found <${node.type}>.` 
      };
    }

    if (node.type === 'dict' && Array.isArray(node.value)) {
      return { ...node, value: validateTree(node.value, {}, false), errorType: null };
    }

    if (rules.isPayloadContentArray && node.type === 'array') {
      const validatedArray = node.value.map(arrayItem => {
        if (arrayItem.type === 'dict') {
          return { ...arrayItem, value: validateTree(arrayItem.value, COMMON_PAYLOAD_KEYS, true) };
        }
        return arrayItem;
      });
      return { ...node, value: validatedArray, errorType: null };
    }

    return { ...node, errorType: null };
  });

  Object.keys(schema).forEach(requiredKey => {
    if (schema[requiredKey].required && !foundKeys.includes(requiredKey)) {
      const targetType = schema[requiredKey].type;
      let defaultValue = '';
      if (targetType === 'integer') defaultValue = '1';
      if (targetType === 'boolean') defaultValue = true;
      if (targetType === 'array') defaultValue = [];
      if (targetType === 'dict') defaultValue = [];

      updatedTree.push({
        key: requiredKey,
        type: targetType,
        value: defaultValue,
        errorType: 'MISSING',
        errorMessage: `Missing required key: Value type must be <${targetType}>.`
      });
    }
  });

  return updatedTree;
};

export default function ProfilePayloadValidator() {
  const [xmlInput, setXmlInput] = useState('');
  const [treeData, setTreeData] = useState(null);
  const [validationRun, setValidationRun] = useState(false);
  const [systemMessage, setSystemMessage] = useState({ type: '', text: '' });

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      setXmlInput(evt.target.result);
      setTreeData(null);
      setValidationRun(false);
      setSystemMessage({ type: 'info', text: `Loaded file: ${file.name}` });
    };
    reader.readAsText(file);
  };

  const handleValidate = () => {
    try {
      if (!xmlInput.trim()) {
        setSystemMessage({ type: 'error', text: 'Please paste or upload an XML Payload first.' });
        return;
      }
      const initialTree = parsePlistXmlToTree(xmlInput);
      const validatedTree = validateTree(initialTree, TOP_LEVEL_SCHEMA);
      setTreeData(validatedTree);
      setValidationRun(true);
      setSystemMessage({ type: 'success', text: 'Validation processed successfully! Review discrepancies below.' });
    } catch (err) {
      setSystemMessage({ type: 'error', text: err.message });
      setTreeData(null);
    }
  };

  const removeUnexpectedKeys = () => {
    const cleanNodes = (nodes) => {
      return nodes
        .filter(n => n.errorType !== 'UNEXPECTED')
        .map(n => {
          if (n.type === 'dict') return { ...n, value: cleanNodes(n.value) };
          if (n.type === 'array') {
            return {
              ...n,
              value: n.value.map(item => item.type === 'dict' ? { ...item, value: cleanNodes(item.value) } : item)
            };
          }
          return n;
        });
    };
    const cleaned = cleanNodes(treeData);
    setTreeData(cleaned);
    setSystemMessage({ type: 'success', text: 'All unexpected keys purged!' });
  };

  const updateNodeValue = (path, newValue, fixedType = null) => {
    const updateRecursive = (nodes, currentPath) => {
      return nodes.map((node, index) => {
        const nodePath = [...currentPath, index];
        const pathMatch = JSON.stringify(nodePath) === JSON.stringify(path);

        if (pathMatch) {
          const updatedNode = { ...node, value: newValue, errorType: null };
          if (fixedType) {
            updatedNode.type = fixedType;
          }
          return updatedNode;
        }

        if (node.type === 'dict') {
          return { ...node, value: updateRecursive(node.value, nodePath) };
        }
        if (node.type === 'array') {
          const updatedArr = node.value.map((arrItem, aIdx) => {
            if (arrItem.type === 'dict') {
              return { ...arrItem, value: updateRecursive(arrItem.value, [...nodePath, aIdx]) };
            }
            return arrItem;
          });
          return { ...node, value: updatedArr };
        }
        return node;
      });
    };

    const updated = updateRecursive(treeData, []);
    setTreeData(updated);
  };

  const handleExport = () => {
    try {
      const generatedXml = convertTreeToPlist(treeData);
      const blob = new Blob([generatedXml], { type: 'application/x-apple-aspen-config' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = "fixed_profile.mobileconfig";
      link.click();
      setSystemMessage({ type: 'success', text: 'Exported compliant payload to file!' });
    } catch (e) {
      setSystemMessage({ type: 'error', text: 'Error rendering XML structure.' });
    }
  };

  const loadSampleData = () => {
    setXmlInput(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadType</key>
    <integer>999</integer>
    <key>PayloadDisplayName</key>
    <string>Broken Sample Profile</string>
    <key>UnwantedBetaKey</key>
    <string>Delete Me Automatically</string>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadType</key>
            <string>com.apple.extensiblesso</string>
            <key>PayloadVersion</key>
            <string>Should Be An Integer</string>
        </dict>
    </array>
</dict>
</plist>`);
    setTreeData(null);
    setValidationRun(false);
    setSystemMessage({ type: 'info', text: 'Injected broken sample payload. Hit "Validate Profile" to inspect.' });
  };

  const renderInteractiveDOMTree = (nodes, currentPath = []) => {
    return (
      <div className="pl-4 border-l border-slate-700 space-y-3 mt-1 font-mono text-sm">
        {nodes.map((node, index) => {
          const nodePath = [...currentPath, index];
          
          let bgClass = "bg-slate-800/40 border-slate-700";
          if (node.errorType === 'UNEXPECTED') bgClass = "bg-red-950/40 border-red-800 text-red-200 animate-pulse";
          if (node.errorType === 'WRONG_TYPE' || node.errorType === 'MISSING') bgClass = "bg-emerald-950/40 border-emerald-800 text-emerald-200";

          return (
            <div key={index} className={\`p-3 rounded-lg border \${bgClass} transition-all\`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                
                <div className="flex items-center space-x-2">
                  <span className="text-amber-400 font-semibold">&lt;key&gt;{node.key}&lt;/key&gt;</span>
                  <span className="text-xs bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded">
                    Type: {node.type}
                  </span>
                  {node.errorType && (
                    <span className="text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500 text-slate-900">
                      {node.errorType}
                    </span>
                  )}
                </div>

                <div className="flex items-center space-x-2">
                  {node.errorType === 'WRONG_TYPE' && (
                    <button
                      onClick={() => updateNodeValue(nodePath, "", node.expectedType)}
                      className="text-xs bg-emerald-600 hover:bg-emerald-500 text-white font-medium px-2 py-1 rounded transition"
                    >
                      Convert to &lt;{node.expectedType}&gt;
                    </button>
                  )}
                </div>
              </div>

              {node.errorMessage && (
                <p className="text-xs mt-1 text-slate-300 font-sans bg-black/30 p-1.5 rounded border border-white/5">
                  ⚠️ {node.errorMessage}
                </p>
              )}

              <div className="mt-2 pl-2">
                {node.type === 'dict' && Array.isArray(node.value) && (
                  <div className="mt-1">
                    <span className="text-slate-500 text-xs">&lt;dict&gt;</span>
                    {renderInteractiveDOMTree(node.value, nodePath)}
                    <span className="text-slate-500 text-xs block mt-1">&lt;/dict&gt;</span>
                  </div>
                )}

                {node.type === 'array' && Array.isArray(node.value) && (
                  <div className="mt-1">
                    <span className="text-slate-500 text-xs">&lt;array&gt;</span>
                    {node.value.map((arrItem, aIdx) => (
                      <div key={aIdx} className="my-2 p-2 bg-slate-900/50 rounded border border-slate-800">
                        <span className="text-xs text-slate-400 block mb-1">Payload Content Object #{aIdx + 1}</span>
                        {arrItem.type === 'dict' ? (
                          renderInteractiveDOMTree(arrItem.value, [...nodePath, aIdx])
                        ) : (
                          <span className="text-slate-300 font-sans">{String(arrItem.value)}</span>
                        )}
                      </div>
                    ))}
                    <span className="text-slate-500 text-xs block mt-1">&lt;/array&gt;</span>
                  </div>
                )}

                {node.type !== 'dict' && node.type !== 'array' && (
                  <div className="flex items-center space-x-2 mt-1">
                    <span className="text-slate-500 text-xs">&lt;{node.type}&gt;</span>
                    {node.type === 'boolean' ? (
                      <input
                        type="checkbox"
                        checked={!!node.value}
                        onChange={(e) => updateNodeValue(nodePath, e.target.checked)}
                        className="w-4 h-4 rounded accent-emerald-500 bg-slate-900 border-slate-700 text-white"
                      />
                    ) : (
                      <input
                        type={node.type === 'integer' || node.type === 'real' ? 'number' : 'text'}
                        value={node.value}
                        onChange={(e) => updateNodeValue(nodePath, e.target.value)}
                        className="bg-slate-950 border border-slate-700 text-slate-100 rounded px-2 py-1 text-xs w-full max-w-md focus:outline-none focus:border-blue-500"
                        placeholder="Provide value..."
                      />
                    )}
                    <span className="text-slate-500 text-xs">&lt;/{node.type}&gt;</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 font-sans">
      <header className="max-w-7xl mx-auto mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
          ⚙️ Apple Profile Payload Validator
        </h1>
        <p className="text-sm text-slate-400 mt-1">
          Validate arbitrary Apple Configuration Plists compliance with TopLevel &amp; CommonPayloadKey declarations. Fix errors inline on structural DOM components.
        </p>
      </header>

      {systemMessage.text && (
        <div className={\`max-w-7xl mx-auto mb-6 p-4 rounded-lg border text-sm flex items-center justify-between \${
          systemMessage.type === 'error' ? 'bg-red-950/40 border-red-800 text-red-200' :
          systemMessage.type === 'success' ? 'bg-emerald-950/40 border-emerald-800 text-emerald-200' : 'bg-blue-950/40 border-blue-800 text-blue-200'
        }\`}>
          <span>{systemMessage.text}</span>
          <button onClick={() => setSystemMessage({ type: '', text: '' })} className="font-bold opacity-60 hover:opacity-100">×</button>
        </div>
      )}

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        <div className="lg:col-span-5 flex flex-col space-y-4">
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl shadow-sm space-y-3">
            <h2 className="text-md font-semibold text-slate-200">1. Raw XML Payload Provision</h2>
            
            <div className="flex gap-2">
              <label className="flex-1 cursor-pointer bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium py-2 px-3 rounded-lg border border-slate-700 text-center transition">
                📁 Upload .mobileconfig / .xml
                <input type="file" accept=".xml,.mobileconfig" onChange={handleFileUpload} className="hidden" />
              </label>
              <button 
                onClick={loadSampleData} 
                className="bg-slate-800/50 hover:bg-slate-800 text-slate-300 text-xs font-medium py-2 px-3 rounded-lg border border-slate-700 transition"
              >
                🧪 Load Faulty Sample
              </button>
            </div>

            <textarea
              className="w-full h-96 bg-slate-950 border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-300 focus:outline-none focus:border-blue-500 resize-y"
              placeholder="Paste Apple Configuration Profile Payload string here..."
              value={xmlInput}
              onChange={(e) => setXmlInput(e.target.value)}
            />

            <button
              onClick={handleValidate}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-2.5 px-4 rounded-lg shadow text-sm tracking-wide transition"
            >
              🔍 Validate Profile Against Spec
            </button>
          </div>
        </div>

        <div className="lg:col-span-7">
          <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl shadow-sm min-h-[540px] flex flex-col">
            <div className="flex flex-wrap items-center justify-between border-b border-slate-800 pb-3 mb-4 gap-2">
              <h2 className="text-md font-semibold text-slate-200 flex items-center gap-2">
                🌲 Interactive Schema DOM Fixer Tree
              </h2>
              {validationRun && treeData && (
                <div className="flex items-center space-x-2">
                  <button
                    onClick={removeUnexpectedKeys}
                    className="bg-red-900/60 hover:bg-red-800 text-red-200 text-xs font-medium py-1.5 px-3 rounded-md border border-red-700 transition"
                  >
                    🧹 Purge All Unexpected
                  </button>
                  <button
                    onClick={handleExport}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold py-1.5 px-3 rounded-md shadow transition"
                  >
                    💾 Export Compliant XML
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto max-h-[580px] pr-2">
              {!validationRun ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-500">
                  <span className="text-4xl mb-2">🚦</span>
                  <p className="text-sm">Provide an XML configuration layout on the left panel and prompt validation execution to populate target remediation logs.</p>
                </div>
              ) : treeData && treeData.length > 0 ? (
                <div className="space-y-1">
                  <span className="text-slate-500 text-xs font-mono">&lt;plist version="1.0"&gt;</span>
                  {renderInteractiveDOMTree(treeData)}
                  <span className="text-slate-500 text-xs font-mono block mt-1">&lt;/plist&gt;</span>
                </div>
              ) : (
                <p className="text-xs text-slate-400 italic">No structured keys detected.</p>
              )}
            </div>
          </div>
        </div>

      </main>
    </div>
  );
}