import { Controller, Get, Post, Param, Query, Delete, UseGuards, UseInterceptors, HttpCode } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse
} from '@nestjs/swagger';

import { MediaSubtitlesService } from './media-subtitles.service';
import { DeleteMediaSubtitlesDto } from './dto';
import { AuthUserDto } from '../users';
import { Media, MediaSubtitle } from './entities';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ErrorMessage } from '../auth';
import { HeadersDto } from '../../common/dto';
import { UploadFileInterceptor } from '../../common/interceptors';
import { ParseBigIntPipe } from '../../common/pipes';
import { AuthGuardOptions } from '../../decorators/auth-guard-options.decorator';
import { AuthUser } from '../../decorators/auth-user.decorator';
import { FileUpload } from '../../decorators/file-upload.decorator';
import { RolesGuardOptions } from '../../decorators/roles-guard-options.decorator';
import { RequestHeaders } from '../../decorators/request-headers.decorator';
import { UserPermission } from '../../enums';
import { UPLOAD_SUBTITLE_TYPES, UPLOAD_SUBTITLE_MAX_SIZE } from '../../config';

@ApiTags('Media')
@ApiExtraModels(Media)
@Controller()
export class MediaSubtitleController {
  constructor(private readonly mediaSubtitlesService: MediaSubtitlesService) {}

  @Post(':id/movie/subtitles')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @UseInterceptors(
    new UploadFileInterceptor({
      maxSize: UPLOAD_SUBTITLE_MAX_SIZE,
      mimeTypes: UPLOAD_SUBTITLE_TYPES,
      skipMimeTypeDetection: true
    })
  )
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({
    summary: `Upload a subtitle (permissions: ${UserPermission.MANAGE_MEDIA})`,
    description: `Subtitle format: WebVTT<br>
    Limit: ${UPLOAD_SUBTITLE_MAX_SIZE} Bytes<br/>
    Mime types: ${UPLOAD_SUBTITLE_TYPES.join(', ')}`
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        language: { type: 'string', description: 'Language of the subtitle (ISO6391)', example: 'en' }
      }
    }
  })
  @ApiOkResponse({ description: 'Return added subtitles' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error.', type: ErrorMessage })
  @ApiUnprocessableEntityResponse({ description: 'Failed to check file type', type: ErrorMessage })
  @ApiUnsupportedMediaTypeResponse({ description: 'Unsupported file', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The user could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiServiceUnavailableResponse({ description: 'Errors from third party API', type: ErrorMessage })
  updateMovieSubtitle(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @FileUpload() file: Storage.MultipartFile,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaSubtitlesService.uploadMovieSubtitle(id, file, headers, authUser);
  }

  @Get(':id/movie/subtitles')
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: 'Find all subtitles in a movie' })
  @ApiOkResponse({ description: 'Return a list of subtitles', type: [MediaSubtitle] })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'The media is private', type: ErrorMessage })
  findAllMovieSubtitles(@AuthUser() authUser: AuthUserDto, @Param('id', ParseBigIntPipe) id: bigint) {
    return this.mediaSubtitlesService.findAllMovieSubtitles(id, authUser);
  }

  @Delete(':id/movie/subtitles/:subtitle_id')
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'subtitle_id', type: String })
  @ApiOperation({ summary: `Delete a subtitle of a media (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Subtitle has beed deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  deleteMovieSubtitle(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('subtitle_id', ParseBigIntPipe) subtitleId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaSubtitlesService.deleteMovieSubtitle(id, subtitleId, headers, authUser);
  }

  @Delete(':id/movie/subtitles')
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Delete multiple subtitles (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Subtitles have beed deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  deleteMovieSubtitles(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Query() deleteMediaSubtitlesDto: DeleteMediaSubtitlesDto
  ) {
    return this.mediaSubtitlesService.deleteMovieSubtitles(id, deleteMediaSubtitlesDto, headers, authUser);
  }

  @Post(':id/tv/episodes/:episode_id/subtitles')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @UseInterceptors(
    new UploadFileInterceptor({
      maxSize: UPLOAD_SUBTITLE_MAX_SIZE,
      mimeTypes: UPLOAD_SUBTITLE_TYPES,
      skipMimeTypeDetection: true
    })
  )
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({
    summary: `Upload a subtitle (permissions: ${UserPermission.MANAGE_MEDIA})`,
    description: `Subtitle format: WebVTT<br>
    Limit: ${UPLOAD_SUBTITLE_MAX_SIZE} Bytes<br/>
    Mime types: ${UPLOAD_SUBTITLE_TYPES.join(', ')}`
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        language: { type: 'string', description: 'Language of the subtitle (ISO6391)', example: 'en' }
      }
    }
  })
  @ApiOkResponse({ description: 'Return added subtitles' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error.', type: ErrorMessage })
  @ApiUnprocessableEntityResponse({ description: 'Failed to check file type', type: ErrorMessage })
  @ApiUnsupportedMediaTypeResponse({ description: 'Unsupported file', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The user could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiServiceUnavailableResponse({ description: 'Errors from third party API', type: ErrorMessage })
  updateTVEpisodeSubtitle(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @FileUpload() file: Storage.MultipartFile,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaSubtitlesService.uploadTVEpisodeSubtitle(id, episodeId, file, headers, authUser);
  }

  @Get(':id/tv/episodes/:episode_id/subtitles')
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({ summary: 'Find all subtitles in a movie' })
  @ApiOkResponse({ description: 'Return a list of subtitles', type: [MediaSubtitle] })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'The episode is private', type: ErrorMessage })
  findAllTVEpisodeSubtitles(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint
  ) {
    return this.mediaSubtitlesService.findAllTVEpisodeSubtitles(id, episodeId, authUser);
  }

  @Delete(':id/tv/episodes/:episode_id/subtitles/:subtitle_id')
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiParam({ name: 'subtitle_id', type: String })
  @ApiOperation({ summary: `Delete a subtitle of a media (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Subtitle has beed deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  deleteTVSubtitle(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @Param('subtitle_id', ParseBigIntPipe) subtitleId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaSubtitlesService.deleteTVEpisodeSubtitle(id, episodeId, subtitleId, headers, authUser);
  }

  @Delete(':id/tv/episodes/:episode_id/subtitles')
  @HttpCode(200)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({ summary: `Delete multiple subtitles (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Subtitles have beed deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  deleteTVSubtitles(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Query() deleteMediaSubtitlesDto: DeleteMediaSubtitlesDto
  ) {
    return this.mediaSubtitlesService.deleteTVEpisodeSubtitles(
      id,
      episodeId,
      deleteMediaSubtitlesDto,
      headers,
      authUser
    );
  }
}
