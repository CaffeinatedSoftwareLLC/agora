import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProviderTerms } from './ProviderTerms';
import { ProviderTermsNotice } from '../messages/ProviderTermsNotice';

const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),patch:vi.fn(),delete:vi.fn()}));
vi.mock('../../lib/api',()=>({api:mocks,inBackground:(fn:()=>unknown)=>fn()}));
const doc={id:'D1',name:'Claude terms',provider:'anthropic',url:'https://example.com',allowed_hosts:['example.com'],enabled:true,
  status:'error',checked_at:null,fetched_at:null,last_change_at:null,error:'HTTP 403',consecutive_failures:3,unacknowledged:1};
const dashboard=()=>({documents:[{...doc}],settings:{intervalHours:24,channelId:null,effectiveChannelId:'C1',lastRunAt:null,requested:false},channels:[{id:'C1',name:'general',server_name:'Owner server'}]});
const change={id:'H1',created_at:'2026-10-19T12:00:00Z',impact:'review',summary:'<img src=x onerror=alert(1)>\nReview this\nCheck policy',diff:'--- previous\n+++ current\n-old\n+new',analysis_status:'no_provider',acknowledged_at:null};
beforeEach(()=>{
  mocks.get.mockImplementation(async(path:string)=>path.includes('/changes')?[change]:dashboard());
  mocks.post.mockResolvedValue({});mocks.patch.mockResolvedValue({});mocks.delete.mockResolvedValue({});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();Object.values(mocks).forEach(m=>m.mockReset());});

it('shows repeated failures, queues a check and saves interval/channel settings',async()=>{
  render(<ProviderTerms/>);
  expect(await screen.findByText('Warning: 3 consecutive failures')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Check now'}));
  await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith('/terms-watch/check',{}));
  expect(await screen.findByText(/Check queued. The worker/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Check interval (hours)'),{target:{value:'48'}});
  fireEvent.change(screen.getByLabelText('Alert channel'),{target:{value:'C1'}});
  fireEvent.click(screen.getByRole('button',{name:'Save settings'}));
  await waitFor(()=>expect(mocks.patch).toHaveBeenCalledWith('/terms-watch/settings',{intervalHours:48,channelId:'C1'}));
});
it('adds a URL with explicit redirect hosts and disables an entry',async()=>{
  render(<ProviderTerms/>);await screen.findByText('Claude terms');
  fireEvent.change(screen.getByLabelText('Name'),{target:{value:'New terms'}});
  fireEvent.change(screen.getByLabelText('HTTPS URL'),{target:{value:'https://new.example/policy'}});
  fireEvent.change(screen.getByLabelText('Allowed redirect hosts (comma separated)'),{target:{value:'new.example, www.new.example'}});
  fireEvent.click(screen.getByRole('button',{name:'Add document'}));
  await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith('/terms-watch/documents',{name:'New terms',url:'https://new.example/policy',provider:'other',allowedHosts:['new.example','www.new.example']}));
  await screen.findByText(/Document added/);
  fireEvent.click(screen.getByRole('button',{name:'Disable'}));
  await waitFor(()=>expect(mocks.patch).toHaveBeenCalledWith('/terms-watch/documents/D1',{enabled:false}));
});
it('renders history as inert text, expands the diff, and acknowledges',async()=>{
  const view=render(<ProviderTerms/>);await screen.findByText('Claude terms');
  fireEvent.click(screen.getByRole('button',{name:'History'}));
  await screen.findByText(/<img src=x onerror=alert\(1\)>/);
  expect(view.container.querySelector('img')).toBeNull();
  fireEvent.click(screen.getByText('View diff'));expect(screen.getByText(/--- previous/)).toBeTruthy();
  await waitFor(()=>expect((screen.getByRole('button',{name:'Acknowledge'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'Acknowledge'}));
  await waitFor(()=>expect(mocks.post).toHaveBeenCalledWith('/terms-watch/changes/H1/acknowledge',{}));
});
it('requires confirmation before removing document history and shows request errors',async()=>{
  const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
  render(<ProviderTerms/>);await screen.findByText('Claude terms');
  fireEvent.click(screen.getByRole('button',{name:'Remove'}));expect(mocks.delete).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);mocks.delete.mockRejectedValue(new Error('Removal failed'));
  fireEvent.click(screen.getByRole('button',{name:'Remove'}));
  expect(await screen.findByText('Removal failed')).toBeTruthy();
});
it('shows a clickable fixed review link and preserves notice summary lines without interpreting remote markup',()=>{
  const {container}=render(<ProviderTermsNotice content={'Provider terms: Test — review\n<script>execute()</script>\nSecond\nThird\nReview: /admin/provider-terms'}/>);
  expect(screen.getByRole('link',{name:'Review provider terms'}).getAttribute('href')).toBe('/admin/provider-terms');
  expect(container.querySelector('script')).toBeNull();expect(screen.getByText(/<script>execute/)).toBeTruthy();
});
