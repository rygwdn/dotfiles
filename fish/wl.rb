#!/usr/bin/env ruby
# frozen_string_literal: true

require 'pathname'
require 'open3'
require 'optparse'
require 'rbconfig'

class WorktreeNavigator
  WORLD_TREES_PATH = File.expand_path('~/world/trees')
  SRC_PATH = File.expand_path('~/src')

  attr_reader :current_dir, :current_worktree

  def initialize
    @current_dir = Dir.pwd
    @current_worktree = extract_current_worktree
    @zoxide_scores = load_zoxide_scores
    @has_shortpath = system('which shortpath > /dev/null 2>&1')
  end

  def run(args)
    @options = parse_options(args)
    query = args.join(' ')

    if @options[:list]
      list
    elsif @options[:test]
      run_tests
    elsif @options[:filter]
      filter_output(query)
    else
      navigate(query)
    end
  end

  private

  def parse_options(args)
    options = {}

    OptionParser.new do |opts|
      opts.banner = "Usage: wl [options] [query]"

      opts.on('--list', 'List all paths') { options[:list] = true }
      opts.on('--scores', 'Include scores in output') { options[:scores] = true }
      opts.on('--test', 'Run unit tests') { options[:test] = true }
      opts.on('--filter QUERY', 'Filter paths (for fzf callback)') { |q| options[:filter] = true; args.clear; args << q if q }
      opts.on('-h', '--help', 'Show this message') do
        puts opts
        exit
      end
    end.parse!(args)

    options
  end

  def extract_current_worktree
    return nil unless @current_dir.include?("#{WORLD_TREES_PATH}/")

    parts = @current_dir.split('/')
    trees_index = parts.index('trees')
    return nil unless trees_index && trees_index < parts.length - 1

    parts[trees_index + 1]
  end

  def load_zoxide_scores
    return {} unless system('which zoxide > /dev/null 2>&1')

    scores = {}
    output, = Open3.capture2('zoxide query -ls')

    output.each_line do |line|
      parts = line.strip.split(/\s+/, 2)
      next if parts.length < 2

      score = parts[0].to_f
      path = Pathname.new(parts[1]).cleanpath.to_s
      scores[path] = score
    end

    scores
  rescue
    {}
  end

  def get_candidates
    candidates = []

    # Add worktree areas
    if Dir.exist?(WORLD_TREES_PATH)
      Dir.glob("#{WORLD_TREES_PATH}/*/").each do |worktree_dir|
        worktree = File.basename(worktree_dir)
        areas_path = File.join(worktree_dir, 'src', 'areas')

        next unless Dir.exist?(areas_path)

        Dir.glob("#{areas_path}/*/").each do |category_dir|
          Dir.glob("#{category_dir}/*/").each do |project_dir|
            project_dir = Pathname.new(project_dir).cleanpath.to_s
            project = File.basename(project_dir)

            # Use original format initially, will update with shortpath later if available
            display_name = "+#{worktree}//#{project}"

            score = @zoxide_scores[project_dir] || 0
            # Boost all projects in the current worktree significantly
            score += 2000 if worktree == @current_worktree

            candidates << {
              score: score,
              display: display_name,
              path: project_dir,
              worktree: worktree,
              project: project
            }
          end
        end
      end
    end

    # Add ~/src repositories (with lower priority)
    if Dir.exist?(SRC_PATH)
      Dir.glob("#{SRC_PATH}/*/").each do |site_dir|
        site = File.basename(site_dir)

        Dir.glob("#{site_dir}/*/").each do |owner_dir|
          owner = File.basename(owner_dir)

          Dir.glob("#{owner_dir}/*/").each do |repo_dir|
            repo_dir = Pathname.new(repo_dir).cleanpath.to_s
            # Only include if it's a git repository
            next unless File.exist?(File.join(repo_dir, '.git'))

            repo = File.basename(repo_dir)

            # Use original format initially, will update with shortpath later if available
            display_name = "~#{site}/#{owner}/#{repo}"

            # Start with zoxide score but subtract 500 to deprioritize src repos
            score = (@zoxide_scores[repo_dir] || 0) - 500

            candidates << {
              score: score,
              display: display_name,
              path: repo_dir
            }
          end
        end
      end
    end

    # Sort by score descending
    candidates.sort_by! { |c| -c[:score] }

    # Update display names using shortpath batch mode if available
    if @has_shortpath
      paths = candidates.map { |c| c[:path] }
      shortpaths = get_shortpaths_batch(paths)

      if shortpaths && shortpaths.length == candidates.length
        candidates.each_with_index do |candidate, i|
          candidate[:display] = shortpaths[i] unless shortpaths[i].nil? || shortpaths[i].empty?
        end
      end
    end

    candidates
  end

  def get_shortpaths_batch(paths)
    return nil if paths.empty?

    input = paths.join("\n")
    output, status = Open3.capture2('shortpath', '--stdin', stdin_data: input)

    return nil unless status.success?

    output.lines.map(&:strip)
  rescue
    nil
  end

  def list
    candidates = get_candidates
    if @options[:scores]
      candidates.each { |c| puts "#{c[:score]} #{c[:display]}\n" }
    else
      candidates.each { |c| puts c[:display] }
    end
  end

  def filter_output(query)
    candidates = get_candidates

    # If empty query, show all
    unless query.nil? || query.empty?
      # Apply our filtering and scoring
      candidates = filter_and_score(candidates, query)
    end

    if @options[:scores]
      candidates.each { |c| puts "#{c[:score]} #{c[:display]}\n" }
    else
      candidates.each { |c| puts "#{c[:display]}\t#{c[:path]}" }
    end
  end

  def navigate(query)
    parent_candidate = get_candidates.find { |c| @current_dir.start_with?(c[:path]) }
    current_location = parent_candidate ? parent_candidate[:display] : ''

    # Find fzf - prefer homebrew location
    fzf_path = if File.exist?('/opt/homebrew/bin/fzf')
      '/opt/homebrew/bin/fzf'
    else
      'fzf'  # Fall back to PATH
    end

    # Use fzf with dynamic reloading through our filter
    script_path = File.expand_path(__FILE__)
    ruby_binary = RbConfig.ruby
    reload = "reload:#{ruby_binary} #{script_path} --filter {q}"

    # Build the complete shell command
    # We use --disabled to start with fzf's search disabled and use our filter
    # The reload binding will call our filter whenever the query changes
    shell_cmd = [
      "'#{ruby_binary}' '#{script_path}' --filter ''",  # Initial empty query
      "|",
      fzf_path,
      "--height=40%",
      "--layout=reverse",
      "--ghost='#{current_location}'",
      "--with-nth=1",
      "--delimiter=$'\\t'",
      "--disabled",
      "--bind", "'change:#{reload}'",
      "--bind", "'start:#{reload}'"
    ]

    # Add initial query if provided
    if query && !query.empty?
      shell_cmd += ["--query", "'#{query}'"]
      # Also update initial filter
      shell_cmd[0] = "'#{ruby_binary}' '#{script_path}' --filter '#{query}'"
    end

    # Execute the command
    result = `#{shell_cmd.join(' ')}`

    # Check exit status
    return unless $?.success? && !result.empty?

    # Extract the path from the selected line
    parts = result.strip.split("\t")
    return unless parts.length >= 2

    path = parts[1]
    puts path
  end

  def filter_and_score(candidates, query)
    return candidates if query.nil? || query.empty?

    query_lower = query.downcase

    # Build fuzzy regex pattern: "abc" -> /.*a.*b.*c.*/
    fuzzy_pattern = Regexp.new(query_lower.chars.map { |c| Regexp.escape(c) }.join('.*'), Regexp::IGNORECASE)

    # Filter candidates that match the fuzzy pattern
    matched = candidates.select do |candidate|
      candidate[:display] =~ fuzzy_pattern
    end

    # Score each matched candidate
    scored = matched.map do |candidate|
      display = candidate[:display]
      base_score = candidate[:score]

      # Calculate match score based on word boundaries vs substring matches
      match_score = 0

      # Check each character in the query
      query_chars = query_lower.chars
      matched_positions = []

      # Find positions of each query character in display
      last_pos = -1
      query_chars.each do |char|
        pos = display.downcase.index(char, last_pos + 1)
        break unless pos
        matched_positions << pos
        last_pos = pos
      end

      # Score based on match positions
      if matched_positions.length == query_chars.length
        # Check if matches are at word boundaries
        word_boundary_matches = 0
        matched_positions.each_with_index do |pos, i|
          # Check if this position is at the start of a word
          if pos == 0 || display[pos - 1] =~ /[\/\-+~._\s]/
            word_boundary_matches += 1
            # Bonus for consecutive word boundary matches
            if i > 0 && matched_positions[i-1] == pos - 1
              word_boundary_matches += 0.5
            end
          end
        end

        # Calculate scores
        match_score = word_boundary_matches * 100

        # Bonus for shorter total match span
        span = matched_positions.last - matched_positions.first + 1
        match_score += (100.0 / span) if span > 0

        # Bonus for matches starting at beginning
        match_score += 50 if matched_positions.first == 0

        # Penalty for longer paths (prefer shorter, more specific matches)
        match_score -= display.length * 0.1
      end

      candidate.merge(
        total_score: base_score + match_score,
        match_score: match_score
      )
    end

    # Sort by total score descending
    scored.sort_by { |c| -c[:total_score] }
  end

  # Unit tests
  def run_tests
    puts "Running unit tests..."

    # Test extract_current_worktree
    original_dir = @current_dir

    @current_dir = "#{WORLD_TREES_PATH}/test-tree/src/areas/clients/frontend"
    assert_equal('test-tree', extract_current_worktree, 'Should extract worktree name')

    @current_dir = '/home/user/projects'
    assert_nil(extract_current_worktree, 'Should return nil for non-worktree path')

    @current_dir = original_dir

    # Test load_zoxide_scores
    scores = load_zoxide_scores
    assert(scores.is_a?(Hash), 'Should return a hash of scores')

    # Test get_candidates
    candidates = get_candidates
    assert(candidates.is_a?(Array), 'Should return an array of candidates')

    if candidates.any?
      first = candidates.first
      assert(first.key?(:score), 'Candidate should have score')
      assert(first.key?(:display), 'Candidate should have display name')
      assert(first.key?(:path), 'Candidate should have path')

      # Check sorting
      scores = candidates.map { |c| c[:score] }
      assert_equal(scores, scores.sort.reverse, 'Candidates should be sorted by score descending')
    end

    # Test filter_and_score
    test_candidates = [
      { display: '+root//web-frontend', score: 2000, path: '/path1' },
      { display: '+other//web-frontend', score: 0, path: '/path2' },
      { display: '+random-fixes//platform', score: 0, path: '/path3' },
      { display: '~github.com/Platform/web-frontend', score: -500, path: '/path4' },
      { display: '~github.com/rygwdn/gt-mcp', score: -500, path: '/path5' },
      { display: '+root//platform', score: 2000, path: '/path6' }
    ]

    # Test 'wf' query - should match web-frontend by word boundaries
    filtered = filter_and_score(test_candidates, 'wf')
    assert(filtered.length > 0, 'Should find matches for "wf"')
    # Should match web-frontend because w and f are at word boundaries
    frontend_matches = filtered.select { |c| c[:display].include?('web-frontend') }
    assert(frontend_matches.length > 0, 'Should match web-frontend for "wf"')
    # Current worktree should be first due to base score
    assert(filtered.first[:display].include?('root'), 'Should prioritize current worktree')

    # Test 'frontend' query - should match by substring
    filtered = filter_and_score(test_candidates, 'frontend')
    assert(filtered.length == 3, 'Should find all web-frontend entries')
    assert(filtered.all? { |c| c[:display].include?('frontend') }, 'All results should contain "frontend"')

    # Test 'plat' query - should match platform
    filtered = filter_and_score(test_candidates, 'plat')
    assert(filtered.any? { |c| c[:display].include?('platform') }, 'Should match platform')
    assert(filtered.any? { |c| c[:display].include?('Platform') }, 'Should match Platform (case insensitive)')

    # Test no matches
    filtered = filter_and_score(test_candidates, 'xyz')
    assert_equal(0, filtered.length, 'Should return empty array for no matches')

    # Test 'rf' query - should match random-fixes by word boundaries
    filtered = filter_and_score(test_candidates, 'rf')
    assert(filtered.any? { |c| c[:display].include?('random-fixes') }, 'Should match random-fixes by word boundaries')

    # Test scoring order for 'wf'
    filtered = filter_and_score(test_candidates, 'wf')
    frontend_entries = filtered.select { |c| c[:display].include?('web-frontend') }

    # Verify scoring hierarchy
    root_entry = frontend_entries.find { |c| c[:display] == '+root//web-frontend' }
    other_entry = frontend_entries.find { |c| c[:display] == '+other//web-frontend' }
    github_entry = frontend_entries.find { |c| c[:display].start_with?('~github.com') }

    if root_entry && other_entry
      assert(root_entry[:total_score] > other_entry[:total_score], 'Current worktree should score higher')
    end
    if other_entry && github_entry
      assert(other_entry[:total_score] > github_entry[:total_score], 'Worktrees should score higher than github')
    end

    puts "\nAll tests passed!"
  end

  def assert_equal(expected, actual, message)
    if expected == actual
      print '.'
    else
      puts "\nFAILED: #{message}"
      puts "  Expected: #{expected.inspect}"
      puts "  Actual: #{actual.inspect}"
      exit 1
    end
  end

  def assert(condition, message)
    if condition
      print '.'
    else
      puts "\nFAILED: #{message}"
      exit 1
    end
  end

  def assert_nil(value, message)
    assert_equal(nil, value, message)
  end
end

# Main execution
if __FILE__ == $0
  navigator = WorktreeNavigator.new
  navigator.run(ARGV)
end
