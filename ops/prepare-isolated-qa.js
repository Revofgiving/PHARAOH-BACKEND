'use strict';
/** Copies SOURCE ONLY into a new QA work directory. Never copies .env, live
 * snapshots, node_modules, keys, signed transactions or arbitrary JSON data.
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function prepare(source,destination){
 const root=fs.realpathSync(source);
 const targetResolved=path.resolve(destination);
 const targetParent=fs.realpathSync(path.dirname(targetResolved));
 const target=path.join(targetParent,path.basename(targetResolved));
 if(target===root||target.startsWith(root+path.sep)||fs.existsSync(target))throw new Error('QA_TARGET_MUST_BE_NEW_AND_OUTSIDE_SOURCE');
 const selected=[];
 function add(rel){if(rel.split(/[\\/]/).includes('..'))throw new Error('QA_PATH_TRAVERSAL');const full=path.join(root,rel),st=fs.lstatSync(full);if(st.isSymbolicLink())throw new Error('QA_SOURCE_SYMLINK_FORBIDDEN');if(!st.isFile())throw new Error('QA_EXPECTED_SOURCE_FILE');selected.push(rel);}
 for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  if(entry.isSymbolicLink())throw new Error('QA_SOURCE_SYMLINK_FORBIDDEN');
  if(entry.isFile()&&(/\.(js|md|txt)$/.test(entry.name)||['package.json','package-lock.json','release-state.json','.env.example','.dockerignore','.gitignore','Dockerfile'].includes(entry.name)))add(entry.name);
 }
 function tree(rel){const full=path.join(root,rel);if(!fs.existsSync(full))return;for(const e of fs.readdirSync(full,{withFileTypes:true})){const child=path.join(rel,e.name);if(e.isSymbolicLink())throw new Error('QA_SOURCE_SYMLINK_FORBIDDEN');if(e.isDirectory())tree(child);else if(/\.(js|sql|md|sh)$/.test(e.name)||child==='database/migration-plan.json')add(child);}}
 for(const dir of ['scripts','ops','database','FORENSIC_EVIDENCE'])tree(dir);
 for(const rel of ['evidence/baseline-recovery.json','evidence/migration-plan-5oct.json'])if(fs.existsSync(path.join(root,rel)))add(rel);
 tree('evidence/legacy-tests-5oct');
 fs.mkdirSync(target,{recursive:false,mode:0o700});const manifest=[];
 for(const rel of [...new Set(selected)].sort()){const bytes=fs.readFileSync(path.join(root,rel)),dest=path.join(target,rel);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.writeFileSync(dest,bytes,{flag:'wx',mode:0o600});manifest.push({file:rel,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
 fs.writeFileSync(path.join(target,'QA_INPUT_MANIFEST.json'),JSON.stringify({sourceOnly:true,productionDataCopied:false,files:manifest},null,2)+'\n',{flag:'wx',mode:0o600});
 return {files:manifest.length,sourceOnly:true};
}
if(require.main===module)try{if(process.argv.length!==3)throw new Error('USAGE_NEW_QA_DIRECTORY');console.log(JSON.stringify(prepare(path.resolve(__dirname,'..'),process.argv[2])));}catch(e){console.error(e.message);process.exitCode=1;}
module.exports={prepare};
