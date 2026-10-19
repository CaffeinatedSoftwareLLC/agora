import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { SessionWorkspace } from './SessionWorkspace';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}));
vi.mock('../../lib/api',()=>({api:mocks,inBackground:(fn:()=>unknown)=>fn()}));
const cp={id:'checkpoint',sha:'a'.repeat(40),ref:'refs/agora/checkpoints/session/1',runId:'run123',messageId:'message456',createdAt:'2026-10-19T12:00:00Z'};
let canManage=true,isOwner=true;
beforeEach(()=>{
    mocks.get.mockReset();mocks.post.mockReset();canManage=true;isOwner=true;
    mocks.get.mockImplementation(async(path:string)=>path.endsWith('/checkpoints')?{checkpoints:[cp],next:null,canManage,isOwner}:{id:'cmd',status:'succeeded',result:{files:['a.ts'],next:null}});
    mocks.post.mockResolvedValue({id:'cmd',status:'queued'});
});
afterEach(()=>vi.useRealTimers());
async function open() {
    fireEvent.click(screen.getByText('Review changes & checkpoints'));
    await screen.findByText('Checkpoints');await waitFor(()=>expect(mocks.get).toHaveBeenCalled());
}
async function finishPoll() { await act(async()=>{await new Promise(r=>setTimeout(r,1100));}); }
it('loads checkpoints only when opened and exposes run/message links',async()=>{
    render(<SessionWorkspace channelId="channel" sessionId="session" onChanged={()=>{}} />);
    expect(mocks.get).not.toHaveBeenCalled();await open();
    expect(screen.getByText('Run run123')).toBeTruthy();expect(screen.getByText('Message message456')).toBeTruthy();
    expect(screen.getByText('Restore to here')).toBeTruthy();expect(screen.getByText('Fork from here')).toBeTruthy();
});
it('hides mutations from readers and restore/fork from directors',async()=>{
    canManage=false;isOwner=false;
    const {unmount}=render(<SessionWorkspace channelId="channel" sessionId="session" onChanged={()=>{}} />);await open();
    expect(screen.queryByText('Commit all')).toBeNull();expect(screen.queryByText('Restore to here')).toBeNull();unmount();
    canManage=true;
    render(<SessionWorkspace channelId="channel" sessionId="session" onChanged={()=>{}} />);await open();
    expect(screen.getByText('Commit all')).toBeTruthy();expect(screen.queryByText('Restore to here')).toBeNull();
});
it('queues a diff, polls for the host result, renders literal diff text and requires confirmation to discard',async()=>{
    render(<SessionWorkspace channelId="channel" sessionId="session" onChanged={()=>{}} />);await open();
    fireEvent.click(screen.getByText('Refresh changed files'));await finishPoll();
    expect(mocks.post).toHaveBeenCalledWith('/channels/channel/sessions/session/workspace-commands',{action:'diff'});
    await screen.findByText('a.ts');
    mocks.get.mockImplementation(async()=>({id:'cmd',status:'succeeded',result:{path:'a.ts',diff:'--- a/a.ts\n+++ b/a.ts\n+<script>literal</script>',next:null,truncated:true}}));
    fireEvent.click(screen.getByText('a.ts'));await finishPoll();
    expect(screen.getByLabelText('Unified diff').textContent).toContain('+<script>literal</script>');expect(screen.getByText(/Patch truncated/)).toBeTruthy();
    const calls=mocks.post.mock.calls.length;fireEvent.click(screen.getByLabelText('Discard a.ts'));
    expect(mocks.post).toHaveBeenCalledTimes(calls);expect(screen.getByText('Confirm discard')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));expect(screen.queryByText('Confirm discard')).toBeNull();
});
it('sends owner restore only after confirmation, then refreshes the session',async()=>{
    const changed=vi.fn();render(<SessionWorkspace channelId="channel" sessionId="session" onChanged={changed} />);await open();
    fireEvent.click(screen.getByText('Restore to here'));expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm restore'));await finishPoll();
    expect(mocks.post).toHaveBeenCalledWith(expect.any(String),{action:'restore',checkpointId:'checkpoint'});expect(changed).toHaveBeenCalledOnce();
});
it('requires a commit message, disables actions during a run, and presents host errors',async()=>{
    const {rerender}=render(<SessionWorkspace channelId="channel" sessionId="session" running onChanged={()=>{}} />);await open();
    expect((screen.getByText('Refresh changed files') as HTMLButtonElement).disabled).toBe(true);
    rerender(<SessionWorkspace channelId="channel" sessionId="session" onChanged={()=>{}} />);
    expect((screen.getByText('Commit all') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Commit message'),{target:{value:'Commit from phone'}});
    mocks.get.mockImplementation(async()=>({id:'cmd',status:'failed',result:{error:'commit_changes_first'}}));
    fireEvent.click(screen.getByText('Commit all'));await finishPoll();
    expect(screen.getByRole('status').textContent).toBe('Commit the session changes first.');
});
it('paginates files and patches and keeps queued mutations from being repeated',async()=>{
    render(<SessionWorkspace channelId="channel" sessionId="session" onChanged={()=>{}} />);await open();
    mocks.get.mockImplementation(async()=>({id:'cmd',status:'succeeded',result:{files:['a.ts'],next:30}}));
    fireEvent.click(screen.getByText('Refresh changed files'));await finishPoll();
    mocks.get.mockImplementation(async()=>({id:'cmd',status:'succeeded',result:{files:['b.ts'],next:null}}));
    fireEvent.click(screen.getByText('More files'));await finishPoll();
    expect(screen.getByText('a.ts')).toBeTruthy();expect(screen.getByText('b.ts')).toBeTruthy();
    expect(mocks.post).toHaveBeenLastCalledWith(expect.any(String),{action:'diff',offset:30});
});
it('resumes polling a pending command after reopening without reissuing it',async()=>{
    let polls=0;
    mocks.get.mockImplementation(async(path:string)=>{
        if(path.endsWith('/checkpoints'))return {checkpoints:[cp],next:null,canManage:true,isOwner:true};
        if(path.endsWith('/latest'))return {command:{id:'pending',status:'claimed',action:'commit',payload:{message:'already submitted'}}};
        polls++;return {id:'pending',status:'succeeded',result:{message:'Committed session changes'}};
    });
    render(<SessionWorkspace channelId="channel" sessionId="session" onChanged={()=>{}} />);await open();await finishPoll();
    expect(mocks.post).not.toHaveBeenCalled();expect(polls).toBe(1);expect(screen.getByRole('status').textContent).toBe('Committed session changes');
});
