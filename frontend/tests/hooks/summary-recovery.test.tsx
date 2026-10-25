import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';

let response: any;
let invokeCalls: Array<[string,any]>;
let updates: any[];
let refreshes: number;
let polls: Array<{ meeting: string; owner: string; callback: (result: any) => void }>;
let stopped: Array<[string,string?]>;
let toasts: any[];
let cancelFails = false;
const startPolling = (meeting: string, owner: string, callback: (result:any)=>void) => { polls.push({meeting,owner,callback}); };
const stopPolling = (meeting:string,owner?:string) => { stopped.push([meeting,owner]); };
mock.module('@/components/Sidebar/SidebarProvider', () => ({useSidebar:()=>({startSummaryPolling:startPolling, stopSummaryPolling:stopPolling})}));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command:string,args:any) => {
  invokeCalls.push([command,args]);
  if (command==='api_get_summary') return typeof response==='function'?response(args.meetingId):response;
  if (command==='api_cancel_summary') { if (cancelFails) throw new Error('IPC failed'); return {}; }
  throw new Error(`unexpected ${command}`);
}}));
mock.module('@tauri-apps/api/event', () => ({listen:async()=>()=>{}}));
mock.module('sonner', () => ({toast:{success:(...a:any[])=>toasts.push(a),error:(...a:any[])=>toasts.push(a),info:()=>{},warning:()=>{}}}));
const {useSummaryGeneration} = await import('../../src/hooks/meeting-details/useSummaryGeneration');
let current: ReturnType<typeof useSummaryGeneration>;
const roots: ReactTestRenderer[]=[];
function Probe({id}:{id:string}) {
 current=useSummaryGeneration({meeting:{id,created_at:'2026-09-18'},transcripts:[],modelConfig:{provider:'claude',model:'claude-sonnet-4-5',whisperModel:'base'},isModelConfigLoading:false,selectedTemplate:'standard',setAiSummary:(value)=>updates.push(value),onMeetingUpdated:async()=>{refreshes++;}});
 return null;
}
async function mount(id='a') { let root!:ReactTestRenderer; await act(async()=>{root=create(<Probe id={id}/>);}); roots.push(root);return root; }
beforeEach(()=>{ response=null;invokeCalls=[];updates=[];refreshes=0;polls=[];stopped=[];toasts=[];cancelFails=false; });
afterEach(async()=>{await act(async()=>{roots.splice(0).forEach(root=>root.unmount());});});

test('returning to a pending summary resumes polling and completion refreshes once',async()=>{
 response={meeting_id:'a',status:'pending',start:'run-a',data:null};
 await mount();
 expect(current.summaryStatus).toBe('processing');expect(polls).toHaveLength(1);
 const done={meeting_id:'a',status:'completed',data:{markdown:'Complete'}};
 await act(async()=>{polls[0].callback(done);polls[0].callback(done);});
 expect(current.summaryStatus).toBe('completed');expect(updates.at(-1)).toEqual(done.data);expect(refreshes).toBe(1);
});
test('opening a historical completion does not replay completion notifications',async()=>{
 response={meeting_id:'a',status:'completed',data:{markdown:'Saved'}};
 await mount();expect(current.summaryStatus).toBe('completed');expect(polls).toHaveLength(0);expect(toasts).toHaveLength(0);expect(refreshes).toBe(0);
});
test('regeneration preserves saved content and can be cancelled after navigation',async()=>{
 response={meeting_id:'a',status:'pending',start:'run-a',data:{markdown:'Previous'}};
 await mount();expect(current.summaryStatus).toBe('regenerating');expect(updates.at(-1)).toEqual(response.data);
 await act(async()=>{await current.handleStopGeneration();});
 expect(invokeCalls.some(([name,args])=>name==='api_cancel_summary'&&args.meetingId==='a')).toBe(true);
 expect(current.summaryStatus).toBe('idle');
 await act(async()=>{polls[0].callback({status:'completed',data:{markdown:'Cancelled late reply'}});});
 expect(updates.at(-1)).toEqual({markdown:'Previous'});
});
test('late hydration cannot overwrite a different meeting',async()=>{
 let resolveA!:(r:any)=>void;
 response=(id:string)=>id==='a'?new Promise(resolve=>{resolveA=resolve;}):{meeting_id:'b',status:'completed',data:{markdown:'B'}};
 const root=await mount();await act(async()=>{root.update(<Probe id="b"/>);});
 await act(async()=>{resolveA({meeting_id:'a',status:'pending',start:'old',data:{markdown:'A'}});});
 expect(updates.at(-1)).toEqual({markdown:'B'});expect(polls).toHaveLength(0);
});
test('unmount cancels only the recovered poll owner and ignores its late reply',async()=>{
 response={meeting_id:'a',status:'pending',start:'run-a',data:null};const root=await mount();
 await act(async()=>{root.unmount();});expect(stopped).toContainEqual(['a',polls[0].owner]);
 await act(async()=>{polls[0].callback({status:'completed',data:{markdown:'Late'}});});expect(updates).toHaveLength(0);
});

test('two views recovering the same native run receive separate local poll owners',async()=>{
 response={meeting_id:'a',status:'pending',start:'same-run',data:null};
 const first=await mount();await mount();expect(polls).toHaveLength(2);
 expect(polls[0].owner).not.toBe(polls[1].owner);
 await act(async()=>{first.unmount();});expect(stopped.at(-1)).toEqual(['a',polls[0].owner]);
});

test('a failed cancellation is not reported as a successful stop',async()=>{
 response={meeting_id:'a',status:'pending',start:'run-a',data:null};await mount();cancelFails=true;
 await act(async()=>{await current.handleStopGeneration();});
 expect(current.summaryStatus).toBe('error');expect(current.summaryError).toContain('Could not cancel');
 expect(stopped).toHaveLength(0);
});
